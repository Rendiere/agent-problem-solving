import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseRegister, lintRegister, selectForThread, threadFromSessionKey, threadMatches, normaliseThread, STATUSES } from "../lib/register.js";
import { buildInjection, doneWhenLine, splitChecks } from "../lib/inject.js";
import { setFields } from "../lib/edit.js";
import { gaugeLine, gaugeLevel } from "../lib/gauge.js";
import { validateConfig } from "../lib/config.js";
import { unpinAfter, stalePins, pinOf, UNPIN_STATUSES } from "../lib/pin.js";

const tokens = (text) => Math.ceil(text.length / 4);

const SAMPLE = `# Problems

Mission: 250 of committed monthly revenue by 31 December, or stop.

## P1. First ten artists emailed
- status: active
- problem: No artist has heard of the product yet.
- serves: committed monthly revenue
- done when: ten personalised emails approved and sent.
- rules out: privacy and compliance polish
- thread: topic:11
- links: LIN-12, JIRA-4
- pushbacks: 2
- corrections: 1
- confirmed: 2026-10-09 active
- updated: 2026-10-09

## P2. Referral links
- status: parked
- thread: topic:11
- updated: 2026-10-12
- state: copy drafted, no code

## P3. Older parked
- status: parked
- thread: topic:11
- updated: 2026-10-01

## P4. Other thread
- status: active
- done when: it works
- confirmed: 2026-10-10 active
- thread: topic:22
`;

const lintCodes = (text) => lintRegister(parseRegister(text)).map((f) => f.code);

test("parses the mission, fields, lists and counts", () => {
  const r = parseRegister(SAMPLE);
  assert.equal(r.problems.length, 4);
  assert.match(r.mission, /committed monthly revenue/);
  const p1 = r.problems[0];
  assert.equal(p1.fields["done when"], "ten personalised emails approved and sent.");
  assert.deepEqual(p1.links, ["LIN-12", "JIRA-4"]);
  assert.equal(p1.pushbacks, 2);
  assert.equal(p1.corrections, 1);
  assert.equal(p1.confirmed.date, "2026-10-09");
  assert.equal(r.problems[1].status, "parked");
});

test("every status in the requirements parses, and nothing else does", () => {
  for (const s of STATUSES) {
    const r = parseRegister(`Mission: m\n\n## P1. x\n- status: ${s}\n- thread: topic:1\n- done when: y\n`);
    assert.equal(r.problems[0].status, s);
    assert.ok(r.problems[0].statusKnown);
  }
  const odd = parseRegister("Mission: m\n\n## P1. x\n- status: finished\n- thread: topic:1\n");
  assert.equal(odd.problems[0].statusKnown, false);
  assert.equal(odd.problems[0].status, "finished");
});

test("an unknown status is reported in lint and in the block", () => {
  const text = "Mission: m\n\n## P1. x\n- status: finished\n- thread: topic:1\n";
  assert.ok(lintCodes(text).includes("status-unknown"));
  const block = buildInjection(parseRegister(text), { thread: "topic:1" });
  assert.match(block, /Unknown status on P1 \("finished"\)/);
});

test("paused parent with an active child parses and lints clean", () => {
  const text = `Mission: m

## P1. Parent
- status: paused
- thread: topic:1
- updated: 2026-10-13
- confirmed: 2026-10-13 paused

## P2. Side task
- status: active
- parent: P1
- thread: topic:1
- done when: the script runs
- confirmed: 2026-10-13 active
- updated: 2026-10-13
`;
  assert.deepEqual(lintCodes(text), []);
  const sel = selectForThread(parseRegister(text), "topic:1");
  assert.equal(sel.main.id, "P2");
  assert.equal(sel.pausedParent.id, "P1");
  assert.match(buildInjection(parseRegister(text), { thread: "topic:1" }), /on P2 Side task \(side task of P1\), P1 Parent paused/);
});

test("two active problems in one thread is a lint error", () => {
  const text = "Mission: m\n\n## P1. a\n- status: active\n- thread: topic:1\n- done when: x\n\n## P2. b\n- status: active\n- thread: topic:1\n- done when: y\n";
  assert.ok(lintCodes(text).includes("two-active"));
});

test("an active problem beside a blocked one in the same thread is a lint error", () => {
  const text = "Mission: m\n\n## P1. a\n- status: blocked\n- thread: topic:1\n\n## P2. b\n- status: active\n- thread: topic:1\n- done when: y\n";
  assert.ok(lintCodes(text).includes("active-beside-blocked"));
});

test("a paused entry with no active child is a lint error", () => {
  const text = "Mission: m\n\n## P1. a\n- status: paused\n- thread: topic:1\n";
  assert.ok(lintCodes(text).includes("paused-without-active-child"));
});

test("a blank thread is a lint error and the entry is active nowhere", () => {
  const text = "Mission: m\n\n## P1. Loose\n- status: active\n- done when: x\n\n## P2. Mine\n- status: active\n- thread: topic:5\n- done when: y\n";
  assert.ok(lintCodes(text).includes("thread-blank"));
  const sel = selectForThread(parseRegister(text), "topic:5");
  assert.deepEqual(sel.here.map((p) => p.id), ["P2"]);
  assert.deepEqual(sel.unthreaded.map((p) => p.id), ["P1"]);
  assert.match(buildInjection(parseRegister(text), { thread: "topic:5" }), /No thread set on: P1/);
});

test("a missing mission line and a missing done-when are lint errors", () => {
  assert.ok(lintCodes("## P1. a\n- status: active\n- thread: topic:1\n").includes("mission-missing"));
  assert.ok(lintCodes("Mission: m\n\n## P1. a\n- status: active\n- thread: topic:1\n").includes("done-when-missing"));
});

test("a status only the operator can set, with no confirmed line, is flagged", () => {
  const codes = lintCodes("Mission: m\n\n## P1. a\n- status: active\n- thread: topic:1\n- done when: x\n");
  assert.ok(codes.includes("unconfirmed"));
  assert.deepEqual(lintCodes(SAMPLE), []);
});

test("the template parses to an empty register", () => {
  const r = parseRegister(readFileSync(new URL("../templates/PROBLEMS.md", import.meta.url), "utf8"));
  assert.equal(r.problems.length, 0);
  assert.equal(r.mission, "");
});

test("thread from a session key, and thread matching", () => {
  assert.equal(threadFromSessionKey("agent:a:telegram:group:-100123:topic:1234"), "topic:1234");
  assert.ok(threadMatches("topic:1234", "topic:1234"));
  assert.ok(threadMatches("1234, topic:7", "topic:7"));
  assert.ok(!threadMatches("topic:123", "topic:1234"));
  assert.ok(threadMatches("any", "topic:1"));
  assert.ok(!threadMatches("", "topic:1"));
});

test("no entries shows no problem and the entry instruction", () => {
  const text = buildInjection(parseRegister("Mission: m\n"), { thread: "topic:5" });
  assert.match(text, /Thread topic:5: no problem\./);
  assert.match(text, /frame-problem skill/);
  assert.match(text, /no obvious route/);
  assert.match(text, /task with clear steps.*no entry/);
  assert.match(text, /keep saying a task's result isn't what they want/);
  assert.doesNotMatch(text, /more than a direct answer|second attempt|fails twice/);
  assert.doesNotMatch(text, /Check before replying/);
});

test("a proposed entry shows awaiting confirmation and no work instruction", () => {
  const text = buildInjection(parseRegister("Mission: m\n\n## P7. Draft\n- status: proposed\n- thread: topic:5\n"), { thread: "topic:5" });
  assert.match(text, /awaiting confirmation on P7 Draft/);
  assert.match(text, /No work on it yet/);
});

test("an open question becomes the stop line and nothing else is asked", () => {
  const text = buildInjection(
    parseRegister("Mission: m\n\n## P1. a\n- status: active\n- thread: topic:1\n- done when: x\n- pending: drift 2026-10-14\n"),
    { thread: "topic:1" },
  );
  const lines = text.split("\n");
  assert.match(lines[2], /^STOP: waiting for the answer to the drift notice on P1/);
  assert.match(text, /Do no further work on this thread until they answer/);
  assert.doesNotMatch(text, /Check before replying/);
});

test("the block stays inside its token budget at the worst shape it can take", () => {
  // Deliberately pathological: five active threads, long titles, a long
  // problem, a long done-when, the gauge at its high level and a long command
  // path. R18 budgets the state it lists (thread, active problem, paused
  // parent, other threads, last parked, mission, gauge) at about 300 tokens;
  // the per-turn check adds the rest and is what a model that never opens the
  // focus skill still has in front of it.
  // The done-when is a twelve-check list, so the block carries as much of one
  // as its cap allows: that is the shape the budget has to hold, not a short
  // one-liner.
  const checklist = Array.from({ length: 12 }, (_, i) => `check ${i + 1} is a sentence someone can actually run and see`).join("; ");
  const reg = `Mission: ten words about the one outcome this agent exists for\n${Array.from({ length: 7 }, (_, i) =>
    `## P${i + 1}. Problem number ${i + 1} with a reasonably long action title\n- status: ${i < 5 ? "active" : i === 5 ? "parked" : "proposed"}\n- problem: ${"word ".repeat(25)}\n- done when: ${checklist}\n- rules out: ${"later ".repeat(10)}\n- state: ${"state ".repeat(15)}\n- thread: topic:${i + 1}\n- updated: 2026-10-13\n`,
  ).join("\n")}`;
  const o = {
    thread: "topic:1",
    reading: { tokens: 520_000, fresh: false, known: true },
    apsCommand: "node /opt/aps/bin/aps.mjs --overlay /srv/overlay --agent assistant",
    registerPath: "/srv/overlay/agents/assistant/PROBLEMS.md",
  };
  const state = buildInjection(parseRegister(reg), { ...o, includeCheck: false });
  const full = buildInjection(parseRegister(reg), o);
  // The budget grew with the done-when cap: closing a problem on a clipped
  // checklist was the bug, so the block pays about 80 tokens for the checks it
  // carries and names the ones it had to leave in the register.
  assert.ok(tokens(state) <= 220, `state ${tokens(state)} tokens`);
  assert.ok(tokens(full) <= 390, `full ${tokens(full)} tokens`);

  // The shape a turn actually meets: one active problem, ordinary lengths.
  const typical = buildInjection(parseRegister(SAMPLE), { ...o, thread: "topic:11", reading: { tokens: 120_000, fresh: true, known: true } });
  assert.ok(tokens(typical) <= 310, `typical ${tokens(typical)} tokens`);
});

test("no instruction tells the agent to switch without asking or to answer first", () => {
  const text = buildInjection(parseRegister(SAMPLE), { thread: "topic:11", reading: 1000 });
  assert.doesNotMatch(text, /switch without asking|follow the switch|answer (first|before asking)/i);
  assert.match(text, /do not switch first/);
  assert.match(text, /stop work on this thread/);
});

test("every question the block tells the agent to ask is written down as a pending line", () => {
  // KTD4: the pending line is what carries the question across a reset, a
  // compaction or an automated turn, so the block names it every time it asks
  // the agent to ask something.
  const onProblem = buildInjection(parseRegister(SAMPLE), { thread: "topic:11", reading: 1000 });
  assert.match(onProblem, /`pending: switch <date>`/);
  assert.match(onProblem, /`pending: drift <date>`/);
  const none = buildInjection(parseRegister("Mission: m\n"), { thread: "topic:5", reading: 1000 });
  assert.match(none, /`pending: enter <date>`/);
  const past = buildInjection(parseRegister(SAMPLE), { thread: "topic:11", reading: 520_000 });
  assert.match(past, /`pending: reset \d{4}-\d{2}-\d{2}`/);
});

test("an automated turn gets a short block with no prompts", () => {
  const worst = parseRegister(`${SAMPLE}\n- pending: drift 2026-10-13\n`);
  const text = buildInjection(worst, { thread: "topic:11", actor: "automated", reading: { tokens: 520_000, fresh: true, known: true } });
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens, ${text.length} chars`);
  assert.doesNotMatch(text, /offer \/new|offer a reset in this reply/);
  assert.match(text, /ask nothing and offer nothing/);
  assert.match(text, /on P1 First ten artists emailed/);
  assert.doesNotMatch(text, /Check before replying/);
  assert.doesNotMatch(text, /Choose one|options/i);
});

test("a degraded read is reported, not silence", () => {
  const text = buildInjection(null, { thread: "topic:1", notice: "Problem register unreadable: EACCES" });
  assert.match(text, /Problem register unreadable: EACCES/);
  assert.match(text, /Say so to the person in one line/);
  assert.doesNotMatch(text, /Thread .*: no problem/);
});

test("gauge: a count below the level, instructions above each one", () => {
  assert.equal(gaugeLine(120_000), "Context: 120k tokens.");
  assert.match(gaugeLine(260_000), /Past 250k: at the next close, park or reframe/);
  assert.match(gaugeLine(510_000), /Past 500k: write the state down, add `pending: reset .*`, offer \/new now, even mid-problem/);
  assert.equal(gaugeLine(null), "Context: unknown.");
  assert.match(gaugeLine({ tokens: 120_000, fresh: false }), /last known/);
  assert.equal(gaugeLevel(249_000), "ok");
  assert.equal(gaugeLevel(250_000), "warn");
  assert.equal(gaugeLevel(500_000), "high");
});

test("the gauge offers a compact only where compacting shrinks the session", () => {
  assert.doesNotMatch(gaugeLine(260_000), /compact/);
  assert.match(gaugeLine(260_000, { canCompact: true }), /\/compact/);
});

test("no string anywhere promises a 200k ceiling or a percentage", () => {
  for (const reading of [120_000, 260_000, 510_000, null]) {
    const line = gaugeLine(reading);
    assert.doesNotMatch(line, /200k|ceiling|%/);
  }
});

test("config: the old ceilingTokens key fails validation", () => {
  assert.deepEqual(validateConfig({ overlayPath: "/tmp/x" }), []);
  assert.ok(validateConfig({ overlayPath: "/tmp/x", ceilingTokens: 200_000 }).some((e) => /ceilingTokens is not a config key/.test(e)));
  assert.ok(validateConfig({}).some((e) => /overlayPath is required/.test(e)));
  assert.ok(validateConfig({ overlayPath: "/tmp/x", warnTokens: 500_000, highTokens: 250_000 }).some((e) => /highTokens must be above/.test(e)));
  assert.ok(validateConfig({ overlayPath: "relative/path" }).some((e) => /overlayPath must match/.test(e)));
  assert.deepEqual(validateConfig({ overlayPath: "/tmp/x", timeZone: "Europe/London" }), []);
});

test("the same thread written two ways is one thread", () => {
  const text = "Mission: m\n\n## P1. a\n- status: active\n- thread: 1234\n- done when: x\n\n## P2. b\n- status: active\n- thread: topic:1234\n- done when: y\n";
  assert.ok(lintCodes(text).includes("two-active"));
  assert.equal(normaliseThread("1234"), "topic:1234");
  assert.equal(normaliseThread("TOPIC:1234"), "topic:1234");
});

test("a repeated id is a lint error", () => {
  const text = "Mission: m\n\n## P1. a\n- status: parked\n- thread: topic:1\n\n## P1. b\n- status: parked\n- thread: topic:2\n";
  assert.ok(lintCodes(text).includes("duplicate-id"));
});

test("no skill tells the agent to act before the operator answers", () => {
  const dir = new URL("../skills/", import.meta.url);
  const skills = readdirSync(dir).map((name) => [name, readFileSync(new URL(`${name}/SKILL.md`, dir), "utf8")]);
  assert.equal(skills.length, 4);
  for (const [name, text] of skills) {
    for (const forbidden of [/do that step/i, /without asking/i, /just do them/i, /answer first/i]) {
      assert.doesNotMatch(text, forbidden, `${name} tells the agent to act before asking`);
    }
  }
  const focus = skills.find(([n]) => n === "focus")[1];
  assert.match(focus, /Only an explicit choice answers an open question/);
  assert.match(focus, /aps report/);
  const frame = skills.find(([n]) => n === "frame-problem")[1];
  assert.match(frame, /pending: enter <date>/);
  // A problem is a gap with no obvious route; a task with steps you could write
  // down now gets done with no entry. No attempt counter turns one into the other.
  const frameTrigger = frame.match(/^description: (.*)$/m)[1];
  assert.match(frameTrigger, /no obvious route/);
  assert.match(frameTrigger, /isn't quite what they want/);
  assert.match(frameTrigger, /Not for a task/);
  for (const [name, text] of skills) {
    assert.doesNotMatch(text, /second attempt|fails twice|no active problem covers/i, `${name} still carries the old trigger`);
  }
  assert.match(frameTrigger, /side task/);
  assert.match(focus, /gets no entry of its own, unless it is a side task/);
  assert.doesNotMatch(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /second attempt|fails twice|more than a direct answer/i);
  assert.match(frame, /C4/);
  assert.match(skills.find(([n]) => n === "reframe")[1], /C4/);
  assert.match(skills.find(([n]) => n === "close-problem")[1], /pending: close <date>/);
});

test("an any-thread active entry holds every thread's slot", () => {
  const text = "Mission: m\n\n## P1. Everywhere\n- status: active\n- thread: any\n- done when: x\n- confirmed: 2026-10-14 active\n\n## P2. Here\n- status: active\n- thread: topic:1\n- done when: y\n- confirmed: 2026-10-14 active\n";
  assert.ok(lintCodes(text).includes("two-active"), lintCodes(text).join(","));
  // On its own it is the thread's one active problem, not a rule break.
  const alone = "Mission: m\n\n## P1. Everywhere\n- status: active\n- thread: any\n- done when: x\n- confirmed: 2026-10-14 active\n";
  assert.deepEqual(lintCodes(alone), []);
});

test("the editor and the parser read the same field on a CRLF register", () => {
  const crlf = "Mission: m\r\n\r\n## P1. Windows\r\n- status: proposed\r\n- thread: topic:1\r\n";
  const out = setFields(crlf, "P1", { status: "parked", state: "held" });
  assert.equal(parseRegister(out).problems[0].status, "parked");
  assert.equal(parseRegister(out).problems[0].fields.state, "held");
  assert.equal(out.split("\n").filter((l) => l && !l.endsWith("\r")).length, 0, "line endings stay consistent");
});

test("the reminder names the fields the counts live in", () => {
  const text = buildInjection(parseRegister(SAMPLE), { thread: "topic:11", reading: 1000 });
  assert.match(text, /pushbacks:/);
  assert.match(text, /corrections:/);
  // R10 says "state line"; the fields are where the parser reads them from.
  assert.doesNotMatch(text, /counts in the state line|keep them in `state`/i);
});

// A done-when is the whole test for closing a problem. The block used to clip
// it at 70 characters, which let the agent close on the first check and never
// see the rest.
const CHECKLIST = [
  "the nightly job has run green three days in a row",
  "the dashboard shows zero failed rows for those days",
  "the runbook names who to call when it fails",
  "the operator has read the summary email and said it reads right",
].join("; ");

test("the block carries every check in a done-when, on a turn from the person and on an automated one", () => {
  const reg = parseRegister(`Mission: m\n\n## P1. Nightly job\n- status: active\n- thread: topic:1\n- done when: ${CHECKLIST}\n- confirmed: 2026-10-14 active\n- updated: 2026-10-14\n`);
  for (const actor of ["person", "automated"]) {
    const text = buildInjection(reg, { thread: "topic:1", actor, reading: 1000 });
    for (const check of CHECKLIST.split("; ")) {
      assert.ok(text.includes(check), `${actor} turn dropped "${check}"`);
    }
    assert.doesNotMatch(text, /Done when: [^\n]*…/, `${actor} turn clipped the done-when`);
  }
});

test("a done-when past the cap keeps whole checks and says how many are left", () => {
  const checks = Array.from({ length: 12 }, (_, i) => `check number ${i + 1} is a sentence long enough to matter here`);
  const line = doneWhenLine(checks.join("; "));
  assert.ok(line.length <= 320, `line is ${line.length} chars`);
  // Whole checks only: every check in the line is one of the originals.
  const shown = line.replace(/ \(\+\d+ more checks? in the register[^)]*\)$/, "").split("; ");
  for (const check of shown) assert.ok(checks.includes(check), `"${check}" was cut mid-way`);
  assert.match(line, /\(\+\d+ more checks in the register/);
  assert.ok(shown.length >= 3, `only ${shown.length} of 12 checks carried`);
});

test("one check too long to fit is cut, says it was cut, and stays inside the cap", () => {
  const one = `the report shows ${"a long clause ".repeat(60)}signed off`.replace(/\s+/g, " ").trim();
  const line = doneWhenLine(one);
  assert.ok(line.length <= 320, `line is ${line.length} chars`);
  assert.match(line, /cut — read the full done-when in the register before closing/);
  assert.ok(one.startsWith(line.split(" …")[0]), "the cut keeps the start of the check");
});

test("every done-when, whatever its shape, comes back inside the cap", () => {
  const shapes = [
    "x".repeat(3000),
    `${"word ".repeat(400)}done`,
    Array.from({ length: 40 }, (_, i) => `check ${i + 1} is a whole sentence about something checkable`).join("; "),
    Array.from({ length: 20 }, (_, i) => `${i + 1}. check ${i + 1} is a whole sentence about something checkable`).join(" "),
  ];
  for (const shape of shapes) assert.ok(doneWhenLine(shape).length <= 320, `${shape.slice(0, 20)}… came back ${doneWhenLine(shape).length} chars`);
});

test("the automated block stays short with a done-when at the cap", () => {
  // The short block pays for the same checklist as the full one: an automated
  // turn works towards the done-when too, and a clipped one is what let a
  // problem be closed on its first check.
  const checklist = Array.from({ length: 12 }, (_, i) => `check ${i + 1} is a sentence someone can actually run and see`).join("; ");
  const reg = parseRegister(`Mission: ten words about the one outcome this agent exists for\n\n## P1. Problem number one with a reasonably long action title\n- status: active\n- thread: topic:1\n- problem: ${"word ".repeat(25)}\n- done when: ${checklist}\n- state: ${"state ".repeat(15)}\n- updated: 2026-10-13\n- pending: drift 2026-10-13\n`);
  const text = buildInjection(reg, { thread: "topic:1", actor: "automated", reading: { tokens: 520_000, fresh: true, known: true } });
  // One cap for both blocks, so there is one rule to explain: the short block
  // pays about 70 tokens for a done-when at the cap instead of 20 for a
  // clipped one.
  assert.ok(tokens(text) <= 230, `${tokens(text)} tokens, ${text.length} chars`);
  assert.match(text, /ask nothing and offer nothing/);
});

test("a decimal in a done-when is not a checklist boundary", () => {
  assert.deepEqual(splitChecks("uptime hits 99. 9 percent and the job runs"), ["uptime hits 99. 9 percent and the job runs"]);
  assert.deepEqual(splitChecks("1. the job runs green 2. the email is sent"), ["1. the job runs green", "2. the email is sent"]);
});

test("the statuses that end a pin are all real statuses", () => {
  for (const s of UNPIN_STATUSES) assert.ok(STATUSES.includes(s), `${s} is not a status`);
});

test("the unpin notice fires on the statuses that end a pin and on nothing else", () => {
  const reg = parseRegister("Mission: m\n\n## P1. Nightly job\n- status: active\n- thread: topic:1\n- done when: x\n- pin: 4211\n");
  const [p1] = reg.problems;
  assert.equal(pinOf(p1), "4211");
  for (const status of ["done", "dropped", "parked"]) {
    const notice = unpinAfter(p1, { status });
    assert.equal(notice.messageId, "4211");
    assert.equal(notice.thread, "topic:1");
    assert.match(notice.text, /unpin/);
    assert.match(notice.text, /tell the operator/);
  }
  for (const status of ["active", "blocked", "paused", "proposed"]) {
    assert.equal(unpinAfter(p1, { status }), null, `${status} should leave the pin alone`);
  }
  const noPin = parseRegister("Mission: m\n\n## P2. No pin\n- status: active\n- thread: topic:1\n- done when: x\n").problems[0];
  assert.equal(unpinAfter(noPin, { status: "done" }), null);
});

test("stalePins lists the ended problems whose pin is still up", () => {
  const reg = parseRegister(
    "Mission: m\n\n## P1. Closed with a pin\n- status: done\n- thread: topic:1\n- pin: 4211\n\n## P2. Closed cleanly\n- status: done\n- thread: topic:1\n\n## P3. Still going\n- status: active\n- thread: topic:2\n- done when: x\n- pin: 4212\n",
  );
  assert.deepEqual(stalePins(reg).map((p) => p.id), ["P1"]);
  assert.equal(stalePins(reg)[0].messageId, "4211");
});
