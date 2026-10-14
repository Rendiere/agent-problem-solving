// Parse and lint a problem register.
//
// Format: a "Mission: ..." line, then one "## P1. <title>" section per problem
// (any "## <LETTERS><digits>." or "## <LETTERS>-<digits>." heading works, so
// P1 and Q-014 both parse). Inside a section, top-level "- key: value" lines are
// fields; nested bullets are notes. HTML comments are stripped, so the
// template's commented example never parses as a problem.

export const STATUSES = ["proposed", "active", "paused", "parked", "blocked", "done", "dropped"];

// Statuses that hold a thread: a thread has at most one of these at a time (R3).
const THREAD_SLOT = ["active", "blocked"];

// Kinds of question the agent can be waiting on (KTD4).
export const PENDING_KINDS = ["enter", "switch", "park", "close", "drop", "reset", "drift"];

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

// One scanner for the parser and the editor (lib/edit.js), so they can never
// disagree about where an entry starts or which line is a field.

/** Any heading closes the entry before it; only an id heading opens one. */
export const HEADING = /^#{1,2}\s/;
export const ID_HEADING = /^##\s+([A-Za-z]+-?\d+)\.?\s*(.*)$/;
/** A top-level "- key: value" bullet. Nested bullets are notes, not fields. */
export const FIELD = /^ ?[-*]\s+([a-z][a-z _-]*?):\s*(.*)$/i;

export function fieldKey(raw) {
  return raw.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Split on either line ending and remember which to write back, so editing a
 * register written on Windows does not leave the old lines invisible to the
 * parser and the new ones invisible to a text editor.
 */
export function splitLines(text) {
  const s = String(text ?? "");
  return { lines: s.split(/\r?\n/), eol: /\r\n/.test(s) ? "\r\n" : "\n" };
}

function toList(value) {
  return String(value ?? "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toCount(value) {
  const n = Number(String(value ?? "").match(/-?\d+/)?.[0]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// "drift 2026-10-14 (asked twice)" -> { kind, date, note, raw }
export function parsePending(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const kind = raw.match(/^[a-z-]+/i)?.[0]?.toLowerCase() ?? "";
  const date = raw.match(ISO_DATE)?.[0] ?? "";
  const note = raw.replace(/^[a-z-]+/i, "").replace(ISO_DATE, "").replace(/^[\s:,-]+/, "").trim();
  return { kind, date, note, raw, known: PENDING_KINDS.includes(kind) };
}

// "2026-10-14 active" -> { date, note }
export function parseConfirmed(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return { date: raw.match(ISO_DATE)?.[0] ?? "", note: raw.replace(ISO_DATE, "").replace(/^[\s:,-]+/, "").trim(), raw };
}

export function parseRegister(text) {
  const clean = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const mission = (clean.match(/^Mission:\s*(.+)$/m)?.[1] ?? "").trim();
  const problems = [];
  let cur = null;
  let lineNo = 0;
  for (const raw of splitLines(clean).lines) {
    lineNo += 1;
    const line = raw.trimEnd();
    if (HEADING.test(line)) {
      // Any heading ends the entry before it, so stray notes under "## Notes"
      // never land on the previous problem.
      const head = line.match(ID_HEADING);
      cur = head ? { id: head[1].toUpperCase(), title: head[2].trim(), line: lineNo, fields: {} } : null;
      if (cur) problems.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = line.match(FIELD);
    if (kv) cur.fields[fieldKey(kv[1])] = kv[2].trim();
  }
  for (const p of problems) {
    const f = p.fields;
    const word = (f.status ?? "proposed").toLowerCase().match(/[a-z]+/)?.[0] ?? "";
    // An unknown status is reported, never coerced into a known one.
    p.statusKnown = STATUSES.includes(word);
    p.status = p.statusKnown ? word : word || "(blank)";
    p.thread = String(f.thread ?? "").trim();
    p.parent = String(f.parent ?? "").trim().toUpperCase();
    p.links = toList(f.links);
    p.pending = parsePending(f.pending);
    p.confirmed = parseConfirmed(f.confirmed);
    p.pushbacks = toCount(f.pushbacks);
    p.corrections = toCount(f.corrections);
    p.learned = String(f.learned ?? "").trim();
    p.updated = String(f.updated ?? "").trim();
  }
  return { mission: mission.startsWith("<") ? "" : mission, problems };
}

// "agent:<id>:telegram:group:-100…:topic:1234" -> "topic:1234"
export function threadFromSessionKey(sessionKey) {
  const key = String(sessionKey ?? "");
  const topic = key.match(/:topic:(\d+)/);
  if (topic) return `topic:${topic[1]}`;
  const parts = key.split(":");
  return parts.length > 2 ? parts.slice(2).join(":") : key;
}

// "1234", "topic:1234" and "TOPIC:1234" are the same thread.
export function normaliseThread(thread) {
  const t = String(thread ?? "").trim().toLowerCase();
  return /^\d+$/.test(t) ? `topic:${t}` : t;
}

// A problem with no thread belongs to no thread; "any" or "all" matches every thread.
export function threadMatches(problemThread, thread) {
  const t = String(problemThread ?? "").trim().toLowerCase();
  if (!t) return false;
  if (t === "any" || t === "all") return true;
  const want = String(thread ?? "").toLowerCase();
  const num = want.match(/topic:(\d+)/)?.[1];
  if (num) return t.split(/[,\s]+/).some((x) => x.replace(/^topic:/, "") === num);
  return t === want;
}

function updatedTime(p) {
  const t = Date.parse(p.updated ?? "");
  return Number.isNaN(t) ? 0 : t;
}

const newestFirst = (a, b) => updatedTime(b) - updatedTime(a);

const isWildcard = (p) => /^(any|all)$/i.test(p.thread);

export function selectForThread(register, thread) {
  const named = (p) => threadMatches(p.thread, thread) && !isWildcard(p);
  const byStatus = (status) => register.problems.filter((p) => p.status === status);
  const active = byStatus("active");
  // Problems naming this thread come first, then "any"-thread problems; newest first within each.
  const here = [
    ...active.filter(named).sort(newestFirst),
    ...active.filter((p) => !named(p) && threadMatches(p.thread, thread)).sort(newestFirst),
  ];
  const main = here[0] ?? null;
  const blocked = byStatus("blocked").filter((p) => threadMatches(p.thread, thread)).sort(newestFirst);
  const parked = byStatus("parked").filter((p) => threadMatches(p.thread, thread)).sort(newestFirst);
  const proposed = byStatus("proposed").filter((p) => threadMatches(p.thread, thread)).sort(newestFirst);
  const paused = byStatus("paused").filter((p) => threadMatches(p.thread, thread)).sort(newestFirst);
  // The paused parent of the side task holding this thread's slot (R9).
  const pausedParent = main?.parent ? paused.find((p) => p.id === main.parent) ?? null : null;
  const pending = [main, ...blocked, ...proposed, ...paused].find((p) => p?.pending) ?? null;
  const unknown = register.problems.filter((p) => !p.statusKnown);
  return {
    active,
    here,
    main,
    blocked,
    blockedHere: blocked[0] ?? null,
    elsewhere: active.filter((p) => !here.includes(p)),
    paused,
    pausedParent,
    lastParked: parked[0] ?? null,
    parked,
    proposed,
    pending,
    unknown,
    unthreaded: register.problems.filter((p) => !p.thread && ["active", "blocked", "paused", "proposed"].includes(p.status)),
  };
}

/**
 * The threads one entry sits in. An entry may name several; "any" names them
 * all, so it is resolved against the threads the rest of the register knows.
 */
export function threadsOf(problem, known = []) {
  if (!problem.thread) return [];
  if (isWildcard(problem)) return known.length ? [...known] : ["any"];
  return [...new Set(problem.thread.split(/[,\s]+/).filter(Boolean).map(normaliseThread))];
}

/** Do these two entries share a thread? "any" shares with every named thread. */
export function threadsOverlap(a, b) {
  if (!a.thread || !b.thread) return false;
  if (isWildcard(a) || isWildcard(b)) return true;
  const mine = new Set(threadsOf(a));
  return threadsOf(b).some((t) => mine.has(t));
}

// Problems that should carry a thread, grouped by thread, for the one-per-thread
// rules. An "any"-thread entry holds every thread's slot, so it is counted in
// each of them (R3).
function byThread(problems) {
  const map = new Map();
  const named = [...new Set(problems.filter((p) => p.thread && !isWildcard(p)).flatMap((p) => threadsOf(p)))];
  for (const p of problems) {
    if (!p.thread) continue;
    for (const key of threadsOf(p, named)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
  }
  return map;
}

// Returns [{ level, code, id, message }]. Level "error" means the register
// breaks a rule in the requirements; "warn" means it needs a human's eye.
export function lintRegister(register) {
  const out = [];
  const add = (level, code, id, message) => out.push({ level, code, id, message });
  // A fresh register has the mission line still to fill in; that is not an error
  // until it holds entries.
  if (!register.mission && register.problems.length) {
    add("error", "mission-missing", null, "No `Mission:` line. The register opens with the agent's mission in one line.");
  }

  const seen = new Map();
  for (const p of register.problems) {
    if (seen.has(p.id)) add("error", "duplicate-id", p.id, `${p.id} appears twice. Every entry needs its own id.`);
    seen.set(p.id, true);
  }
  for (const p of register.problems) {
    if (!p.statusKnown) add("error", "status-unknown", p.id, `Unknown status "${p.fields.status ?? ""}". Use one of: ${STATUSES.join(", ")}.`);
    if (!p.thread && ["active", "blocked", "paused", "proposed", "parked"].includes(p.status)) {
      add("error", "thread-blank", p.id, "No `thread:` set, so this entry belongs to no thread. Ask which thread it is in.");
    }
    if (p.status === "active" && !p.fields["done when"]) add("error", "done-when-missing", p.id, "An active problem needs a `done when:` anyone could check.");
    if (p.pending && !p.pending.known) add("warn", "pending-unknown", p.id, `Unknown pending kind "${p.pending.kind}". Use one of: ${PENDING_KINDS.join(", ")}.`);
    if (["active", "done", "dropped"].includes(p.status) && !p.confirmed) {
      add("warn", "unconfirmed", p.id, `status: ${p.status} with no \`confirmed:\` line. Only the operator moves a problem to active, done or dropped.`);
    }
    if (p.parent && !register.problems.some((q) => q.id === p.parent)) add("error", "parent-missing", p.id, `\`parent: ${p.parent}\` names no entry in this register.`);
  }

  for (const [thread, problems] of byThread(register.problems)) {
    const actives = problems.filter((p) => p.status === "active");
    if (actives.length > 1) add("error", "two-active", actives.map((p) => p.id).join(", "), `${thread} holds ${actives.length} active problems. A thread has at most one.`);
    const proposals = problems.filter((p) => p.status === "proposed");
    if (proposals.length > 1) add("error", "two-proposed", proposals.map((p) => p.id).join(", "), `${thread} holds ${proposals.length} proposed entries. Ask about one at a time.`);
    const blocked = problems.filter((p) => p.status === "blocked");
    if (actives.length && blocked.length) {
      add("error", "active-beside-blocked", [...actives, ...blocked].map((p) => p.id).join(", "), `${thread} holds an active problem beside a blocked one. A blocked problem keeps the thread's slot until it is parked or unblocked.`);
    }
    for (const parent of problems.filter((p) => p.status === "paused")) {
      const children = register.problems.filter((p) => p.parent === parent.id);
      if (!children.some((c) => c.status === "active")) {
        add("error", "paused-without-active-child", parent.id, "Paused with no active child. Paused is only for a parent whose side task holds the thread.");
      }
    }
  }
  return out;
}

export function degradedNotice(reason) {
  return `Problem register unreadable: ${String(reason ?? "unknown reason").replace(/\s+/g, " ").trim()}`;
}
