// Parse and check a problem register (PROBLEMS.md).
//
// Format: a "Mission: ..." line, then one "## P<n>. <title>" section per
// problem with top-level "- key: value" lines. Nested bullets are notes, not
// fields. HTML comments are stripped, so a template's commented example never
// parses as a real entry.

/** Every status a problem may hold. Nothing outside this list is coerced into it. */
export const STATUSES = Object.freeze([
  "proposed",
  "active",
  "paused",
  "parked",
  "blocked",
  "done",
  "dropped",
]);

/** The kinds of question an agent can be waiting on. */
export const PENDING_KINDS = Object.freeze([
  "enter",
  "switch",
  "park",
  "close",
  "drop",
  "drift",
  "reset",
  "reword",
]);

/** A status that keeps a thread's single slot: no second problem may go active. */
const HOLDS_SLOT = new Set(["active", "blocked"]);

const COUNT_FIELDS = ["pushbacks", "corrections"];

function fieldKey(raw) {
  return raw.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

function splitList(value) {
  return String(value ?? "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// "drift 2026-10-14" / "drift, asked 2026-10-14" -> { kind, date, raw }
function parsePending(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /^(none|no|-)$/i.test(raw)) return null;
  const kind = raw.toLowerCase().match(/[a-z]+/)?.[0] ?? "";
  const date = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  return { kind, date, raw, known: PENDING_KINDS.includes(kind) };
}

function parseConfirmed(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /^(no|none|-)$/i.test(raw)) return null;
  return { raw, date: raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "" };
}

function parseCount(value) {
  const n = Number.parseInt(String(value ?? "").match(/-?\d+/)?.[0] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function parseRegister(text) {
  const clean = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const missionRaw = (clean.match(/^Mission:\s*(.+)$/m)?.[1] ?? "").trim();
  const problems = [];
  let cur = null;
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{1,2}\s/.test(line)) {
      const head = line.match(/^##\s+(P\d+)\.?\s*(.*)$/);
      cur = head ? { id: head[1], title: head[2].trim(), fields: {}, duplicateFields: [] } : null;
      if (cur) problems.push(cur);
      continue;
    }
    if (!cur) continue;
    // Top-level bullets only (at most one leading space); deeper ones are notes.
    const kv = line.match(/^ ?[-*]\s+([a-z][a-z _-]*?):\s*(.*)$/i);
    if (kv) {
      const key = fieldKey(kv[1]);
      if (Object.hasOwn(cur.fields, key)) cur.duplicateFields.push(key);
      cur.fields[key] = kv[2].trim();
    }
  }
  for (const p of problems) {
    const f = p.fields;
    const word = (f.status ?? "proposed").toLowerCase().match(/[a-z]+/)?.[0] ?? "";
    p.statusRaw = (f.status ?? "").trim();
    p.status = word;
    p.unknownStatus = !STATUSES.includes(word);
    p.thread = String(f.thread ?? "").trim();
    p.parent = String(f.parent ?? "").trim().match(/P\d+/)?.[0] ?? "";
    p.links = splitList(f.links);
    p.pending = parsePending(f.pending);
    p.confirmed = parseConfirmed(f.confirmed);
    for (const k of COUNT_FIELDS) p[k] = parseCount(f[k]);
    p.holdsSlot = HOLDS_SLOT.has(p.status);
  }
  // A mission line that is still the template's placeholder counts as unset.
  const mission = missionRaw.startsWith("<") ? "" : missionRaw;
  return { mission, problems };
}

/** "agent:alpha:telegram:group:-100…:topic:42" -> "topic:42" */
export function threadFromSessionKey(sessionKey) {
  const key = String(sessionKey ?? "");
  const topic = key.match(/:topic:(\d+)/);
  if (topic) return `topic:${topic[1]}`;
  const parts = key.split(":");
  return parts.length > 2 ? parts.slice(2).join(":") : key;
}

/** A problem with no thread belongs to no thread; "any"/"all" matches every thread. */
export function threadMatches(problemThread, thread) {
  const t = String(problemThread ?? "").trim().toLowerCase();
  if (!t) return false;
  if (t === "any" || t === "all") return true;
  const want = String(thread ?? "").toLowerCase();
  const num = want.match(/topic:(\d+)/)?.[1];
  if (num) return t.split(/[,\s]+/).some((x) => x.replace(/^topic:/, "") === num);
  return t === want;
}

export function normaliseThread(thread) {
  const t = String(thread ?? "").trim().toLowerCase();
  return /^\d+$/.test(t) ? `topic:${t}` : t;
}

function threadTokens(thread) {
  return String(thread ?? "")
    .split(/[,\s]+/)
    .map(normaliseThread)
    .filter(Boolean);
}

const isWildcard = (p) => /^(any|all)$/i.test(p.thread);

function updatedTime(p) {
  const t = Date.parse(p.fields.updated ?? "");
  return Number.isNaN(t) ? 0 : t;
}

const newestFirst = (a, b) => updatedTime(b) - updatedTime(a);

/**
 * What this thread is on. A thread holds at most one active problem; a blocked
 * problem keeps the slot until it is parked or unblocked (R3).
 */
export function selectForThread(register, thread) {
  const inThread = (p) => Boolean(p.thread) && threadMatches(p.thread, thread);
  const named = (p) => inThread(p) && !isWildcard(p);
  const pick = (status) => {
    const all = register.problems.filter((p) => p.status === status && inThread(p));
    return [...all.filter(named).sort(newestFirst), ...all.filter((p) => !named(p)).sort(newestFirst)];
  };

  const activeHereAll = pick("active");
  const blockedHere = pick("blocked");
  const proposedHere = pick("proposed");
  const activeHere = activeHereAll[0] ?? null;
  const pausedParent = activeHere?.parent
    ? register.problems.find((p) => p.id === activeHere.parent && p.status === "paused") ?? null
    : null;

  const active = register.problems.filter((p) => p.status === "active");
  const elsewhere = active.filter((p) => p !== activeHere && !inThread(p));
  const lastParked =
    register.problems.filter((p) => p.status === "parked").sort(newestFirst)[0] ?? null;
  const unthreaded = register.problems.filter(
    (p) => !p.thread && (p.status === "active" || p.status === "proposed" || p.status === "blocked"),
  );

  // The open question outranks everything else the agent is told (KTD4).
  const pendingHere =
    [activeHere, ...blockedHere, ...proposedHere, pausedParent].find((p) => p?.pending) ?? null;

  let state = "no-problem";
  if (activeHere) state = "on-problem";
  else if (blockedHere.length) state = "blocked";
  else if (proposedHere.length) state = "awaiting-confirmation";

  return {
    state,
    active,
    activeHere,
    extraActiveHere: activeHereAll.slice(1),
    blockedHere,
    proposedHere,
    pausedParent,
    pendingHere,
    elsewhere,
    lastParked,
    unthreaded,
  };
}

/**
 * Every rule a register must hold. Returns one entry per problem found, so a
 * hand-edited file reports all of its faults at once rather than the first.
 */
export function lintRegister(register) {
  const out = [];
  const add = (code, message, problem) => out.push({ code, message, problem: problem ?? null });
  if (!register.mission) add("mission-missing", "No mission line. Add 'Mission: <one line>' at the top.");

  const byId = new Map(register.problems.map((p) => [p.id, p]));
  if (byId.size !== register.problems.length) {
    const seen = new Set();
    for (const p of register.problems) {
      if (seen.has(p.id)) add("duplicate-id", `${p.id} appears more than once.`, p.id);
      seen.add(p.id);
    }
  }

  for (const p of register.problems) {
    for (const key of new Set(p.duplicateFields ?? [])) {
      add("duplicate-field", `${p.id} has more than one '${key}:' line. Keep one.`, p.id);
    }
    if (p.unknownStatus) {
      add("status-unknown", `${p.id} has an unknown status '${p.statusRaw || "(blank)"}'. Use one of: ${STATUSES.join(", ")}.`, p.id);
    }
    const open = !["done", "dropped"].includes(p.status);
    if (open && !p.thread) add("thread-blank", `${p.id} has no thread. Set 'thread: <thread>' or 'any'.`, p.id);
    if (p.status === "active" && !p.fields["done when"]) {
      add("done-when-missing", `${p.id} is active with no done-when.`, p.id);
    }
    if (p.parent && !byId.has(p.parent)) add("parent-unknown", `${p.id} names parent ${p.parent}, which is not in the register.`, p.id);
    if (p.pending && !p.pending.known) {
      add("pending-unknown", `${p.id} has an unknown pending kind '${p.pending.kind}'. Use one of: ${PENDING_KINDS.join(", ")}.`, p.id);
    }
    if (p.status === "paused") {
      const children = register.problems.filter((c) => c.parent === p.id);
      if (!children.some((c) => c.status === "active")) {
        add("paused-without-active-child", `${p.id} is paused but no side task of it is active. Resume it or park it.`, p.id);
      }
    }
  }

  // One slot per thread. Multi-thread entries join every named group. An
  // any/all entry joins every group because it is active everywhere.
  const groups = new Map();
  const wildcard = [];
  for (const p of register.problems) {
    if (!p.thread) continue;
    const tokens = threadTokens(p.thread);
    if (tokens.some((t) => t === "any" || t === "all")) {
      wildcard.push(p);
      continue;
    }
    for (const key of tokens) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
  }
  if (!groups.size && wildcard.length) groups.set("any", []);
  for (const [thread, group] of groups) {
    const all = [...new Set([...group, ...wildcard])];
    const actives = all.filter((p) => p.status === "active");
    const blocked = all.filter((p) => p.status === "blocked");
    const proposed = all.filter((p) => p.status === "proposed");
    if (actives.length > 1) {
      add("thread-two-active", `Thread ${thread} has ${actives.length} active problems (${actives.map((p) => p.id).join(", ")}); a thread holds one.`);
    }
    if (actives.length && blocked.length) {
      add("thread-active-and-blocked", `Thread ${thread} has an active problem (${actives[0].id}) while ${blocked[0].id} is blocked there; a blocked problem keeps the slot.`);
    }
    if (proposed.length > 1) {
      add("thread-two-proposed", `Thread ${thread} has ${proposed.length} proposed problems (${proposed.map((p) => p.id).join(", ")}); a thread holds one.`);
    }
  }
  return out;
}
