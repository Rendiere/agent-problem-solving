// The decision log: every status change and every question put to the person,
// appended and never rewritten (R33).
//
// Two writers reach it. `aps set` logs the change it just made, so the log
// works in layer 1 with no plugin at all, and advances the agent's snapshot so
// the hook does not log the same change twice. The hook diffs the register
// against that snapshot and logs whatever was edited by hand (KTD6).

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** Every kind of line the log holds. */
export const KINDS = Object.freeze([
  "opened",
  "resumed",
  "paused",
  "parked",
  "switched",
  "blocked",
  "closed",
  "dropped",
  "reworded",
  "status-change",
  "drift notice",
  "reset offer",
  "question",
  "answer",
]);

const PENDING_KIND_TO_LOG = { drift: "drift notice", reset: "reset offer" };

const STATUS_TO_KIND = {
  parked: "parked",
  paused: "paused",
  blocked: "blocked",
  done: "closed",
  dropped: "dropped",
  proposed: "reworded",
};

/** Statuses only the operator may set, so an unconfirmed move to one is worth flagging. */
export const OPERATOR_ONLY = Object.freeze(["active", "done", "dropped"]);

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------- snapshot

export function snapshotOf(register) {
  return {
    mission: register?.mission ?? "",
    problems: (register?.problems ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      thread: p.thread,
      parent: p.parent,
      pending: p.pending?.kind ?? "",
      confirmed: p.confirmed?.date ?? "",
      updated: p.fields.updated ?? "",
    })),
  };
}

export function snapshotPath(stateDir, agentId) {
  return path.join(stateDir, `${agentId}.snapshot.json`);
}

export async function readSnapshot(stateDir, agentId) {
  try {
    return JSON.parse(await readFile(snapshotPath(stateDir, agentId), "utf8"));
  } catch {
    return null;
  }
}

export async function writeSnapshot(stateDir, agentId, snapshot) {
  await mkdir(stateDir, { recursive: true });
  const file = snapshotPath(stateDir, agentId);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
}

// -------------------------------------------------------------------- lock

/**
 * One writer at a time per agent. `mkdir` is atomic on every platform that
 * matters, so the directory itself is the lock. A lock older than `staleMs`
 * belonged to a process that died and is taken over.
 */
export async function withLock(stateDir, agentId, fn, { staleMs = 10_000, waitMs = 4_000 } = {}) {
  await mkdir(stateDir, { recursive: true });
  const dir = path.join(stateDir, `${agentId}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const age = await stat(dir).then((s) => Date.now() - s.mtimeMs, () => Infinity);
      if (age > staleMs) {
        const stale = `${dir}.stale-${process.pid}-${Date.now()}`;
        await rename(dir, stale).catch(() => {});
        await rm(stale, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock on ${agentId} held for over ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- diff

/**
 * What changed between a snapshot and the register now. One line per
 * transition, plus a line for each question raised or answered.
 *
 * @returns {Array<object>} log entries without `at`/`agent`/`source`
 */
export function diffRegister(snapshot, register, { now = new Date(), actor = "person" } = {}) {
  const before = new Map((snapshot?.problems ?? []).map((p) => [p.id, p]));
  const out = [];
  const problems = register?.problems ?? [];
  const autoResumed = new Set();
  for (const child of problems) {
    const oldChild = before.get(child.id);
    if (child.parent && oldChild?.status === "active" && child.status !== "active") {
      const parent = problems.find((p) => p.id === child.parent);
      if (parent?.status === "active" && before.get(parent.id)?.status === "paused") autoResumed.add(parent.id);
    }
  }

  // Which threads saw a problem go active in this diff: a park beside one of
  // those is a switch, not a plain park.
  const wentActive = new Map();
  for (const p of problems) {
    const was = before.get(p.id);
    if (p.status === "active" && was?.status !== "active" && p.thread) wentActive.set(p.thread.toLowerCase(), p.id);
  }

  for (const p of problems) {
    const was = before.get(p.id);
    const base = { thread: p.thread, problem: p.id, title: p.title };

    if (!was) {
      out.push({ ...base, kind: "opened", status: p.status, from: "", to: p.status });
    } else if (was.status !== p.status) {
      let kind;
      if (p.status === "active") kind = was.status === "proposed" ? "opened" : "resumed";
      else kind = STATUS_TO_KIND[p.status] ?? "status-change";
      const entry = { ...base, kind, status: p.status, from: was.status, to: p.status };
      if (p.status === "parked" && p.thread) {
        const other = wentActive.get(p.thread.toLowerCase());
        if (other && other !== p.id) {
          entry.kind = "switched";
          entry.to_problem = other;
        }
      }
      out.push(entry);
    }

    // Questions. Raised and answered are separate lines, each logged once.
    const wasPending = was?.pending ?? "";
    const nowPending = p.pending?.kind ?? "";
    if (nowPending && nowPending !== wasPending) {
      out.push({ ...base, kind: PENDING_KIND_TO_LOG[nowPending] ?? "question", pending: nowPending, outcome: "" });
    } else if (wasPending && !nowPending) {
      out.push({
        ...base,
        kind: PENDING_KIND_TO_LOG[wasPending] ?? "answer",
        pending: wasPending,
        outcome: outcomeFor(wasPending, was, p),
      });
    }

    // An operator-only status with nothing recording the operator's yes.
    const flag = unconfirmedFlag(was, p, { now, actor, autoResumed: autoResumed.has(p.id) });
    if (flag) out.push({ ...base, kind: "status-change", status: p.status, flag });
  }

  for (const [id, was] of before) {
    if (!problems.some((p) => p.id === id)) {
      out.push({ thread: was.thread, problem: id, title: was.title, kind: "status-change", from: was.status, to: "gone", flag: "entry removed from the register" });
    }
  }
  return out;
}

/** The person's recorded choice, read from what the register did when the question cleared. */
function outcomeFor(pendingKind, was, now) {
  if (pendingKind === "reset") return "reset";
  if (was.status === now.status) return "stay";
  if (now.status === "parked") return "park";
  if (now.status === "active") return "resume";
  if (now.status === "done") return "close";
  if (now.status === "dropped") return "drop";
  if (now.status === "proposed") return "reword";
  return now.status;
}

function unconfirmedFlag(was, p, { now, actor, autoResumed }) {
  if (!OPERATOR_ONLY.includes(p.status)) return "";
  if (was?.status === p.status) return "";
  if (autoResumed && was?.status === "paused" && p.status === "active") return "";
  const date = p.confirmed?.date ?? "";
  if (!date) return `moved to ${p.status} with no confirmed: line`;
  if (date !== today(now)) return `moved to ${p.status} with a confirmed: line dated ${date}, not today`;
  if (actor === "automated") return `moved to ${p.status} during an automated turn`;
  return "";
}

// --------------------------------------------------------------- appending

/** Append one line per entry. The file is only ever opened in append mode. */
export async function appendLog(file, entries, { agent, source, actor = "person", now = new Date() } = {}) {
  if (!entries.length) return 0;
  await mkdir(path.dirname(file), { recursive: true });
  const at = now.toISOString();
  const body = entries
    .map((e) => JSON.stringify({ at, date: at.slice(0, 10), agent, actor, source, ...e }))
    .join("\n");
  await appendFile(file, `${body}\n`, { encoding: "utf8", flag: "a" });
  return entries.length;
}

export async function readLog(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ unparsed: line });
    }
  }
  return out;
}

// ------------------------------------------------------------- turn counts

/**
 * One row per agent per day: how many turns the person took and how many of
 * them sat above each gauge level (R39). Kept beside the snapshot, not in the
 * append-only log, because it is a running total.
 */
export function countsPath(stateDir, agentId) {
  return path.join(stateDir, `${agentId}.turns.json`);
}

export async function recordTurn(stateDir, agentId, { band, person, now = new Date() }) {
  const file = countsPath(stateDir, agentId);
  let data = {};
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    data = {};
  }
  const day = today(now);
  const row = (data[day] ??= { turns: 0, person: 0, warn: 0, high: 0 });
  row.turns += 1;
  if (person) {
    row.person += 1;
    if (band === "warn") row.warn += 1;
    if (band === "high") row.high += 1;
  }
  // Keep a month; the reviewer reads the log for anything older.
  for (const k of Object.keys(data)) {
    if ((Date.now() - Date.parse(k)) / 86_400_000 > 31) delete data[k];
  }
  await mkdir(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, file);
  return data[day];
}

export async function readCounts(stateDir, agentId) {
  try {
    return JSON.parse(await readFile(countsPath(stateDir, agentId), "utf8"));
  } catch {
    return {};
  }
}

export function turnMarkerPath(stateDir, agentId) {
  return path.join(stateDir, `${agentId}.turn.json`);
}

export async function writeTurnMarker(stateDir, agentId, marker) {
  await mkdir(stateDir, { recursive: true });
  const file = turnMarkerPath(stateDir, agentId);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...marker, at: new Date().toISOString() }), "utf8");
  await rename(tmp, file);
}

export async function readTurnMarker(stateDir, agentId, { freshMs = 10 * 60_000 } = {}) {
  try {
    const marker = JSON.parse(await readFile(turnMarkerPath(stateDir, agentId), "utf8"));
    const at = Date.parse(marker.at ?? "");
    return !Number.isNaN(at) && Date.now() - at <= freshMs ? marker : null;
  } catch {
    return null;
  }
}
