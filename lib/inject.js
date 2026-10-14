// The block the agent reads before every reply.
//
// It carries the mission, what this thread is on, any question still waiting
// for an answer, and how full the session is (R18). A full turn gets the check
// list; an automated turn gets a shorter block and is told to ask nobody (R19).
//
// Everything here is written for whoever installs the plugin: "the person" is
// whoever the agent is talking to. No name, channel or business belongs in this
// file.

import { selectForThread, lintRegister } from "./register.js";
import { automatedGaugeLine, gaugeLine } from "./gauge.js";

const MAX = { mission: 110, problem: 110, doneWhen: 100, rulesOut: 60, state: 80, title: 40 };

function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const label = (p) => `${p.id} ${clip(p.title, MAX.title)}`;

/** The stop line. An open question outranks every other instruction (KTD4, R12). */
function stopLine(p) {
  const kind = p.pending.kind;
  const asked = p.pending.date ? ` (asked ${p.pending.date})` : "";
  const what = {
    drift: "the drift notice",
    enter: "the question about entering this problem",
    switch: "the switch question",
    park: "the park question",
    close: "the close question",
    drop: "the question about dropping it",
    reset: "the reset offer",
    reword: "the reworded entry",
  }[kind] ?? `the ${kind} question`;
  const rule =
    kind === "reset"
      ? `Do not start new work on ${p.id} until they answer.`
      : `Do no work on ${p.id} until they answer.`;
  return [
    `WAITING for the person's answer to ${what} on ${p.id}${asked}. ${rule}`,
    `If their message is an explicit choice, act on it and clear the pending line with \`aps set\`. If it is anything else, answer a fact or a reminder, then restate the question in one line.`,
  ].join("\n");
}

const CHECK = (id) =>
  [
    "Check before you reply:",
    `1. Does this reply move ${id}'s done-when? Related is not the same as moving it. Yes: carry on.`,
    `2. Does it belong to a different problem? Ask first, in one line: "Park ${id} (<its state>) and switch?" Write \`pending: switch <date>\`; never switch before they answer.`,
    `3. Not moving the done-when, and no switch was asked for? That is drift. Open with "🧭 I noticed we're veering off ${id}: <what pulled us away>", then three numbered options (go back, reframe, park and switch). Write \`pending: drift <date>\`; stop work until they pick.`,
    `4. Does it need a smaller job done first? Draft that as its own entry with \`parent: ${id}\` and ask before starting it.`,
    "A fact, reminder or chat: answer. No entry.",
    "Record every status change and the `pushbacks:` and `corrections:` counts with `aps set`, never by hand.",
  ].join("\n");

const ENTER =
  "No problem on this thread. If the person asks for work that takes more than a direct answer, draft the register entry (`frame-problem`), write `pending: enter <date>` and ask them to confirm it before you start. A fact, a reminder or a chat needs no entry.";

const AWAIT_CONFIRM =
  "Awaiting the person's confirmation. Do not start the work until they confirm the entry; reword it if they ask.";

const AUTOMATED_RULE =
  "This turn was not started by the person, so ask them nothing. If you would have asked, write the question on the entry as `pending: <kind> <today>` with `aps set` and carry on; they will meet it on their next turn.";

function degradedBlock(reason, { reading, gauge }) {
  return [
    "[problem register]",
    `Problem register unreadable: ${reason}.`,
    "Tell the person this in one line before you do anything else, and do not treat it as 'no active problem'.",
    gaugeLine(reading, gauge),
  ].join("\n");
}

/**
 * @param {{register?: object, degraded?: string}} source
 * @param {{thread: string, reading?: any, gauge?: object, automated?: boolean}} opts
 */
export function buildInjection(source, opts = {}) {
  const { thread, reading = null, gauge = {}, automated = false, command = "" } = opts;
  const degraded = source?.degraded ?? (source === null ? "no register was found" : "");
  if (degraded) return degradedBlock(degraded, { reading, gauge });

  const register = source.register ?? source;
  const sel = selectForThread(register, thread);
  const p = sel.activeHere;
  const lines = ["[problem register]"];
  if (register.mission) lines.push(`Mission: ${clip(register.mission, MAX.mission)}`);

  // 1. What this thread is on.
  const where = `Thread ${thread}`;
  if (p) {
    const f = p.fields;
    lines.push(`${where} — on ${label(p)}.`);
    if (f.problem) lines.push(`Problem: ${clip(f.problem, MAX.problem)}`);
    lines.push(`Done when: ${clip(f["done when"], MAX.doneWhen) || "NOT SET — ask the person for one before going further."}`);
    if (sel.pausedParent) lines.push(`This is a side task. Paused parent: ${label(sel.pausedParent)} — it resumes when this one closes or is dropped.`);
    if (p.pushbacks || p.corrections) lines.push(`Pushbacks ${p.pushbacks}, self-corrections ${p.corrections} on this problem.`);
  } else if (sel.blockedHere.length) {
    lines.push(`${where} — ${label(sel.blockedHere[0])} is BLOCKED and still holds this thread. ${clip(sel.blockedHere[0].fields.state, MAX.state)}`);
    lines.push("Nothing else goes active here until it is unblocked or parked.");
  } else if (sel.proposedHere.length) {
    lines.push(`${where} — awaiting confirmation on ${label(sel.proposedHere[0])}.`);
    lines.push(AWAIT_CONFIRM);
  } else {
    lines.push(`${where} — no problem.`);
  }

  // 2. The rest of the state, one line each.
  if (sel.extraActiveHere.length) {
    lines.push(`LINT: ${sel.extraActiveHere.length + 1} active problems on this thread (${[p, ...sel.extraActiveHere].map((x) => x.id).join(", ")}). Ask which to park.`);
  }
  if (sel.elsewhere.length) {
    lines.push(`Other threads: ${sel.elsewhere.slice(0, 4).map((x) => `${label(x)} (${x.thread})`).join("; ")}`);
  }
  if (sel.lastParked) {
    lines.push(`Last parked: ${label(sel.lastParked)}${sel.lastParked.fields.state ? `. ${clip(sel.lastParked.fields.state, MAX.state)}` : ""}`);
  }
  if (p && sel.proposedHere.length) {
    lines.push(`Also awaiting confirmation: ${sel.proposedHere.map(label).join("; ")}`);
  }
  if (sel.unthreaded.length) {
    lines.push(`No thread set on: ${sel.unthreaded.map(label).join("; ")}. Ask which thread each belongs to.`);
  }

  lines.push(gaugeLine(reading, gauge));
  if (command) lines.push(command);

  // 3. What to do. An open question comes before anything else.
  if (sel.pendingHere) {
    lines.push(stopLine(sel.pendingHere));
    if (automated) lines.push(AUTOMATED_RULE);
    return lines.join("\n");
  }
  if (automated) {
    lines.push(AUTOMATED_RULE);
    return lines.join("\n");
  }
  if (p) lines.push(CHECK(p.id));
  else if (!sel.blockedHere.length && !sel.proposedHere.length) lines.push(ENTER);
  return lines.join("\n");
}

/** The short block for an automated turn (R19). */
export function buildShortInjection(source, opts = {}) {
  const { thread, reading = null, gauge = {}, command = "" } = opts;
  const degraded = source?.degraded ?? (source === null ? "no register was found" : "");
  if (degraded) return degradedBlock(degraded, { reading, gauge });
  const register = source.register ?? source;
  const sel = selectForThread(register, thread);
  const p = sel.activeHere;
  const lines = ["[problem register]"];
  if (register.mission) lines.push(`Mission: ${clip(register.mission, 80)}`);
  if (p) {
    lines.push(`Thread ${thread} — on ${label(p)}. Done when: ${clip(p.fields["done when"], 80)}`);
    if (sel.pausedParent) lines.push(`Paused parent: ${label(sel.pausedParent)}`);
  } else {
    lines.push(`Thread ${thread} — no active problem.`);
  }
  if (sel.pendingHere) lines.push(`${sel.pendingHere.id} is waiting on the person's answer to the ${sel.pendingHere.pending.kind} question. Do no work on it.`);
  lines.push(automatedGaugeLine(reading, gauge));
  if (command) lines.push(command);
  lines.push(AUTOMATED_RULE);
  return lines.join("\n");
}

/** Lint findings worth putting in front of the agent. */
export function lintNotes(register) {
  return lintRegister(register).map((e) => e.message);
}
