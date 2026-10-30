// The block the hook puts in front of each turn (R18, R19). Full version for a
// turn from the person, short version for an automated one. The budgets are
// measured in test/register.test.js at the worst shape the block can take, so
// every line here is written to be short. The one line that is allowed to run
// long is the done-when: closing a problem on a clipped checklist was a real
// failure, so the checks are carried up to DONE_WHEN_CAP and the ones left
// behind are counted.

import { selectForThread } from "./register.js";
import { gaugeLine } from "./gauge.js";

// Each branch keeps its trigger, the words the person has to see, and the
// `pending:` line that carries the question across a reset. The longer version
// of all of it is in the focus skill; this is what a model that never opens the
// skill still has in front of it.
const CHECK = [
  "Check: does this reply move the done-when? Related is not moving it.",
  '- Other work asked: "Park <ID> (<state>) and switch?" 1. Park and switch 2. Stay. `pending: switch <date>`; do not switch first.',
  '- Moves nothing, nobody asked: drift. Open with "🧭 I noticed we\'re veering off <ID title>: <why>", then 1. Back to it 2. Reframe 3. Park and switch. `pending: drift <date>`; stop work on this thread.',
  "- Side task first: own entry, `parent: <ID>`, ask, <ID> paused; its own side task asks first.",
  "- Reframe after two pushbacks, two self-corrections, a stop-gap, or before a build.",
  "- Fact, reminder, chat: answer, no entry.",
  "Status and the counts in `pushbacks:`/`corrections:`: `aps set`, never a hand edit.",
].join("\n");

const NO_PROBLEM =
  "If they bring a problem (a gap with no obvious route to close it), or keep saying a task's result isn't what they want: draft one entry (frame-problem skill), write `pending: enter <date>`, and ask them to confirm before starting. A task with clear steps, a fact or chat: do it, no entry.";

function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// A done-when is a checklist, and a checklist cut in half lets the agent close
// a problem on its first check. So the whole list is carried, and the cap that
// bounds the block can only ever drop whole checks — never half of one, and
// never silently: a cut always says to go and read the entry.
const DONE_WHEN_CAP = 320;
const CUT_NOTE = " … (cut — read the full done-when in the register before closing)";
const moreNote = (n) => ` (+${n} more check${n === 1 ? "" : "s"} in the register — read the entry before closing)`;

/**
 * The checks in a done-when: split on ";" and on "1." / "2)" numbering. The
 * numbered form needs a one- or two-digit marker followed by a word, so "99. 9
 * percent" stays one check rather than becoming two.
 */
export function splitChecks(text) {
  const bySemicolon = text.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  if (bySemicolon.length > 1) return bySemicolon;
  const numbered = text.split(/\s+(?=\d{1,2}[.)]\s+[^\d\s])/).map((s) => s.trim()).filter(Boolean);
  return numbered.length > 1 ? numbered : (text.trim() ? [text.trim()] : []);
}

/**
 * The done-when as the block carries it: every check, in full, while the list
 * fits the cap. Past the cap it carries whole checks and counts the rest, and
 * one check too long to fit is the only thing ever cut — with the note that
 * says so. The returned line never runs past the cap.
 */
export function doneWhenLine(value, cap = DONE_WHEN_CAP) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= cap) return text;
  const checks = splitChecks(text);
  // The note is part of the line, so it comes out of the same budget.
  const budget = cap - Math.max(CUT_NOTE.length, moreNote(checks.length).length);
  const kept = [];
  let used = 0;
  for (const check of checks) {
    if (used + check.length + (kept.length ? 2 : 0) > budget) break;
    used += check.length + (kept.length ? 2 : 0);
    kept.push(check);
  }
  // Nothing fits: one check longer than the whole budget. Cut it, and say so.
  if (!kept.length) return `${text.slice(0, cap - CUT_NOTE.length).trim()}${CUT_NOTE}`;
  const dropped = checks.length - kept.length;
  return dropped > 0 ? `${kept.join("; ")}${moreNote(dropped)}` : kept.join("; ");
}

const short = (p) => `${p.id} ${clip(p.title, 36)}`;

const STOP_LINE = {
  enter: (p) => `waiting for them to confirm entering ${short(p)}`,
  switch: (p) => `waiting for the answer to the switch question on ${short(p)}; do not switch`,
  park: (p) => `waiting for the answer to the park question on ${short(p)}`,
  close: (p) => `waiting for them to confirm closing ${short(p)}; do not mark it done yourself`,
  drop: (p) => `waiting for them to confirm dropping ${short(p)}; do not mark it dropped yourself`,
  reset: (p) => `a reset was offered on ${short(p)}; its state is written down, so wait for /new or a no`,
  drift: (p) => `waiting for the answer to the drift notice on ${short(p)}`,
};

function stopLine(pending) {
  const p = pending.problem;
  const body = (STOP_LINE[pending.kind] ?? ((q) => `waiting for their answer on ${short(q)} (${pending.kind})`))(p);
  return `STOP: ${body}.${pending.since ? ` Asked ${pending.since}.` : ""} Do no further work on this thread until they answer; facts and reminders are fine.`;
}

function pendingOf(sel) {
  const p = sel.pending;
  return p ? { kind: p.pending.kind, problem: p, since: p.pending.date } : null;
}

function stateLine(sel, thread) {
  const where = `Thread ${thread ?? "unknown"}`;
  if (sel.main) {
    const parent = sel.pausedParent ? `, ${short(sel.pausedParent)} paused` : "";
    const side = sel.main.parent ? ` (side task of ${sel.main.parent})` : "";
    return `${where}: on ${short(sel.main)}${side}${parent}.`;
  }
  if (sel.blockedHere) return `${where}: ${short(sel.blockedHere)} is blocked and keeps the slot. Park it or clear the block; start nothing else here.`;
  if (sel.proposed.length) return `${where}: awaiting confirmation on ${sel.proposed.slice(0, 2).map(short).join("; ")}. No work on it yet.`;
  return `${where}: no problem.`;
}

function detailLines(sel) {
  const lines = [];
  const m = sel.main;
  if (m) {
    const f = m.fields;
    const parts = [];
    if (f.problem) parts.push(`Problem: ${clip(f.problem, 50)}`);
    parts.push(`Done when: ${doneWhenLine(f["done when"])}`);
    if (m.links.length) parts.push(`Links: ${m.links.slice(0, 4).join(", ")}`);
    lines.push(parts.join(" "));
    if (m.pushbacks || m.corrections) lines.push(`${m.id}: ${m.pushbacks} pushback(s), ${m.corrections} self-correction(s).`);
    if (sel.here.length > 1) lines.push(`Also active here, one too many — ask which to park: ${sel.here.slice(1).map(short).join("; ")}`);
  }
  if (sel.elsewhere.length) lines.push(`Active elsewhere: ${sel.elsewhere.slice(0, 3).map((p) => clip(short(p), 24)).join("; ")}`);
  if (sel.lastParked) lines.push(`Last parked: ${short(sel.lastParked)}${sel.lastParked.fields.state ? `. ${clip(sel.lastParked.fields.state, 60)}` : ""}`);
  if (sel.unthreaded.length) lines.push(`No thread set on: ${sel.unthreaded.slice(0, 3).map(short).join("; ")}. Ask which thread each belongs to.`);
  if (sel.unknown.length) lines.push(`Unknown status on ${sel.unknown.slice(0, 3).map((p) => `${p.id} ("${clip(p.fields.status, 20)}")`).join("; ")}. Fix it with \`aps set\`.`);
  return lines;
}

/**
 * @param {object|null} register parsed register, or null when there is none
 * @param {object} o
 * @param {string} o.thread      this thread's id, e.g. "topic:1234"
 * @param {"person"|"automated"} o.actor who this turn came from
 * @param {string|null} o.notice degraded-read notice, when the register could not be read
 * @param {string} o.apsCommand  how to run the command in this deployment
 */
export function buildInjection(register, o = {}) {
  const { thread, actor = "person", notice = null, reading = null, gauge = {}, registerFile = "PROBLEMS.md", registerPath = registerFile, apsCommand = null, date, includeCheck = true, includeGauge = true } = o;
  const lines = ["[problem register]"];
  // A runtime that reports no session size gets no gauge line. "Context:
  // unknown." on every turn of every session is noise, not a reading.
  const gaugeText = includeGauge ? gaugeLine(reading, { ...gauge, actor, ...(date ? { date } : {}) }) : null;
  const freshSession = reading && typeof reading === "object" && reading.known === false;

  if (notice) {
    lines.push(`${notice}. Say so to the person in one line, and do not act as if no problem were active.`);
    if (gaugeText) lines.push(gaugeText);
    return lines.join("\n");
  }
  if (!register) {
    lines.push(`No register at ${registerPath}. ${actor === "person" ? NO_PROBLEM : "Automated turn: do no problem-solving work and ask nothing."}`);
    if (gaugeText) lines.push(gaugeText);
    return lines.join("\n");
  }

  const sel = selectForThread(register, thread);
  const pending = pendingOf(sel);
  lines.push(stateLine(sel, thread));
  if (pending) lines.push(stopLine(pending));

  if (actor === "automated") {
    if (sel.main) lines.push(`Done when: ${doneWhenLine(sel.main.fields["done when"])}`);
    if (gaugeText) lines.push(gaugeText);
    lines.push("Automated turn, so nobody is there: ask nothing and offer nothing. A question you would have asked goes on the entry as a `pending:` line instead, and waits for their next turn.");
    return lines.join("\n");
  }

  if (register.mission) lines.push(`Mission: ${clip(register.mission, 90)}`);
  lines.push(...detailLines(sel));
  if (!sel.main && !sel.blockedHere && !sel.proposed.length) lines.push(NO_PROBLEM);
  if (gaugeText) lines.push(gaugeText);
  if (freshSession && sel.main) lines.push(`First turn of this session: open your reply with "Back on: ${short(sel.main)}".`);
  if (apsCommand) lines.push(`Change it: ${apsCommand}`);
  if (includeCheck && !pending && (sel.main || sel.blockedHere)) lines.push(CHECK);
  return lines.join("\n");
}
