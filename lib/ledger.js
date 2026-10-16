// The append-only decision log (R33, KTD6).
//
// Two writers reach it: `aps set`, which logs the change it just made, and the
// hook, which diffs the register against the snapshot it last saw and logs
// whatever was changed by hand. Both read the register inside the same lock and
// advance the same snapshot, so each transition is logged exactly once. Nothing
// in here ever opens the log for anything but appending.

import { appendFile, mkdir, readFile, writeFile, rename, rm, stat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseRegister } from "./register.js";
import { today } from "./gauge.js";

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 3_000;

/** A lock held by someone else is a reason to skip, never to hang. */
export const BUSY = Symbol("aps lock busy");

export async function withLock(lockFile, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}-${randomUUID()}`;
  for (;;) {
    try {
      await mkdir(path.dirname(lockFile), { recursive: true });
      await mkdir(lockFile);
      try {
        await writeFile(path.join(lockFile, "owner"), token, "utf8");
      } catch (err) {
        await rm(lockFile, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Breaking a stale lock by renaming it first means two waiters cannot both
      // decide to remove it and then both walk in.
      if ((await lockAge(lockFile)) > LOCK_STALE_MS) {
        const aside = `${lockFile}.stale-${process.pid}-${Date.now()}`;
        await rename(lockFile, aside).catch(() => {});
        await rm(aside, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) return BUSY;
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    // A stale holder must never remove the lock that replaced its own. The
    // token distinguishes this lock from a new directory at the same path.
    let owner = null;
    try {
      owner = await readFile(path.join(lockFile, "owner"), "utf8");
    } catch {}
    if (owner === token) await rm(lockFile, { recursive: true, force: true });
  }
}

async function lockAge(lockFile) {
  try {
    return Date.now() - (await stat(lockFile)).mtimeMs;
  } catch {
    return 0;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export function snapshotOf(register) {
  const problems = {};
  for (const p of register?.problems ?? []) {
    problems[p.id] = {
      title: p.title,
      status: p.status,
      thread: p.thread,
      parent: p.parent || null,
      pending: p.pending?.raw ?? null,
      confirmed: p.confirmed?.date ?? null,
    };
  }
  return { problems };
}

export async function readSnapshot(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && parsed.problems ? parsed : null;
  } catch {
    return null;
  }
}

export const writeSnapshot = (file, snapshot) => writeJsonAtomic(file, snapshot);

// What to call a move between two statuses, in the vocabulary R33 lists.
export function transitionKind(from, to) {
  if (!from) return "drafted";
  if (from === to) return null;
  switch (to) {
    case "active":
      return from === "proposed" ? "opened" : "switched";
    case "paused":
      return "paused";
    case "parked":
      return "parked";
    case "blocked":
      return "blocked";
    case "done":
      return "closed";
    case "dropped":
      return "dropped";
    case "proposed":
      return "reworded";
    default:
      return `moved to ${to}`;
  }
}

const QUESTION_KIND = { drift: "drift notice", reset: "reset offer" };
const questionKind = (kind) => QUESTION_KIND[kind] ?? `${kind} question`;
const kindOfPending = (raw) => String(raw ?? "").match(/^[a-z-]+/i)?.[0]?.toLowerCase() ?? "unknown";

// What the person chose, read from the question they answered and what the
// status did in the same breath.
export function outcomeFor(pendingKind, from, to, nextPendingKind = null) {
  if (pendingKind === "reset") return "reset";
  // The wording question is answered two ways: a reword, which asks it again,
  // or agreement, which moves framing on to the rest of the entry.
  if (pendingKind === "frame") {
    if (nextPendingKind === "frame") return "reworded";
    if (from === to) return "wording agreed";
  }
  if (from === to) return pendingKind === "close" ? "keep going" : "stay";
  switch (to) {
    case "active":
      return ["enter", "frame"].includes(pendingKind) ? "enter" : "switch";
    case "parked":
      return ["drift", "park", "frame"].includes(pendingKind) ? "park" : "switch";
    case "proposed":
      return "reframe";
    case "done":
      return "close";
    case "dropped":
      return "drop";
    case "paused":
      return "pause";
    default:
      return to;
  }
}

/**
 * Transitions and question changes between two snapshots.
 * @returns {Array<object>} ledger entries without the common metadata
 */
export function diffSnapshots(prev, next) {
  const out = [];
  const before = prev?.problems ?? {};
  const after = next?.problems ?? {};
  for (const [id, now] of Object.entries(after)) {
    const was = before[id];
    const common = { problem: id, title: now.title, thread: now.thread };
    const kind = transitionKind(was?.status, now.status);
    if (kind) out.push({ ...common, kind, from: was?.status ?? null, to: now.status, confirmed: now.confirmed ?? null });

    const wasPending = was?.pending ?? null;
    if (wasPending && wasPending !== now.pending) {
      const k = kindOfPending(wasPending);
      out.push({ ...common, kind: `${questionKind(k)} answered`, outcome: outcomeFor(k, was.status, now.status, kindOfPending(now.pending)), raised: wasPending });
    }
    // A question replaced by a different one logs the answer to the first and
    // then the new question, so neither goes missing.
    if (now.pending && now.pending !== wasPending) {
      out.push({ ...common, kind: questionKind(kindOfPending(now.pending)), raised: now.pending, outcome: null });
    }
  }
  for (const [id, was] of Object.entries(before)) {
    if (!after[id]) out.push({ problem: id, title: was.title, thread: was.thread, kind: "removed from the register", from: was.status, to: null });
  }
  return out;
}

const NEEDS_CONFIRMATION = new Set(["opened", "switched", "closed", "dropped"]);

/**
 * Why this entry needs the operator's eye, or null.
 * @param {object} entry   a diff entry
 * @param {object} o
 * @param {"person"|"automated"} o.actor who was on the turn the change landed in
 * @param {string} o.day   the day the change landed
 * @param {string|null} o.lastPersonTurn day of the newest turn from the person
 */
export function flagFor(entry, { actor = "person", day = today(), lastPersonTurn = null } = {}) {
  if (!NEEDS_CONFIRMATION.has(entry.kind)) return null;
  if (!["active", "done", "dropped"].includes(entry.to)) return null;
  if (!entry.confirmed) return "no confirmed: line for a change only the operator can make";
  if (entry.confirmed !== day) return `confirmed: ${entry.confirmed} is not the day the change landed (${day})`;
  if (actor === "automated") return "confirmed during an automated turn, so the operator did not answer it";
  if (lastPersonTurn && lastPersonTurn < day) return "no turn from the operator on the day the change landed";
  return null;
}

export async function appendLedger(file, entries) {
  if (!entries.length) return 0;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return entries.length;
}

export async function readLedger(file) {
  try {
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { kind: "unreadable log line", raw: line };
        }
      });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export function stamp(entry, { agent, actor, at = new Date(), source, day = today(at) }) {
  return {
    at: at.toISOString(),
    day,
    agent,
    actor,
    source,
    thread: entry.thread || null,
    problem: entry.problem,
    title: entry.title ?? null,
    kind: entry.kind,
    from: entry.from ?? null,
    to: entry.to ?? null,
    outcome: entry.outcome ?? null,
    raised: entry.raised ?? null,
    flag: entry.flag ?? null,
  };
}

/**
 * Log everything changed outside `aps set`, then advance the snapshot. The
 * register is re-read inside the lock, so a change that lands between the
 * hook's own read and the lock cannot be logged backwards or twice.
 *
 * @returns {Array<object>|typeof BUSY} the entries written, or BUSY when
 * another writer holds the lock. BUSY is not a failure: the next turn's diff
 * covers whatever this one skipped.
 */
export async function logHandEdits({ registerFile, snapshotFile, ledgerFile, agent, actor, day = today(), lastPersonTurn = null, at = new Date(), waitMs }) {
  return withLock(
    `${snapshotFile}.lock`,
    async () => {
      let text;
      try {
        text = await readFile(registerFile, "utf8");
      } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
      }
      const next = snapshotOf(parseRegister(text));
      const prev = await readSnapshot(snapshotFile);
      // A first run records the register as it stands; it is not a pile of transitions.
      if (!prev) {
        await writeSnapshot(snapshotFile, next);
        return [];
      }
      const entries = diffSnapshots(prev, next).map((e) =>
        stamp({ ...e, flag: flagFor(e, { actor, day, lastPersonTurn }) }, { agent, actor, at, source: "hand-edit", day }),
      );
      await appendLedger(ledgerFile, entries);
      await writeSnapshot(snapshotFile, next);
      return entries;
    },
    waitMs === undefined ? {} : { waitMs },
  );
}

/**
 * Which turn is in progress, so a change written by the agent inherits that
 * turn's actor. Written by the hook, read by `aps set`.
 */
export async function writeTurnMarker(file, { actor, sessionKey = null, at = new Date() }) {
  await writeJsonAtomic(file, { actor, sessionKey, at: at.toISOString() });
}

export async function readTurnMarker(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.actor ? parsed : null;
  } catch {
    return null;
  }
}

/** Newest marker for a project thread, used when a hand-written command has no session id. */
export async function readNewestTurnMarker(dir) {
  let newest = null;
  try {
    for (const name of await readdir(dir)) {
      const marker = await readTurnMarker(path.join(dir, name));
      if (!marker) continue;
      if (!newest || Date.parse(marker.at ?? "") > Date.parse(newest.at ?? "")) newest = marker;
    }
  } catch {}
  return newest;
}

/** The actor to credit a command with: the live turn's, if there is one. */
export function actorFromMarker(marker, { now = Date.now(), freshMs = 10 * 60_000 } = {}) {
  if (!marker) return "person";
  const at = Date.parse(marker.at ?? "");
  if (Number.isNaN(at) || now - at > freshMs) return "person";
  return marker.actor === "automated" ? "automated" : "person";
}

/** Turn counts per day. The share above the warning level counts the operator's turns (R39). */
export async function recordTurn(file, { day = today(), actor = "person", level = "ok", waitMs } = {}) {
  return withLock(`${file}.lock`, async () => {
    let data = {};
    try {
      data = JSON.parse(await readFile(file, "utf8")) ?? {};
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("turn counts are not an object");
    } catch (err) {
      if (err?.code !== "ENOENT") {
        // Keep whatever was there: these counts are the only evidence for R39.
        await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      }
      data = {};
    }
    const row = data[day] ?? { person: 0, automated: 0, aboveWarn: 0 };
    const person = actor === "person";
    row[person ? "person" : "automated"] += 1;
    if (person && (level === "warn" || level === "high")) row.aboveWarn += 1;
    data[day] = row;
    if (person) data.lastPersonTurn = day;
    await writeJsonAtomic(file, data);
    return row;
  }, waitMs === undefined ? {} : { waitMs });
}

export async function readTurns(file) {
  try {
    return JSON.parse(await readFile(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}
