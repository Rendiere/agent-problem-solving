// The once-a-day close-check: on the first turn of the day the agent compares
// the active problem's done-when against evidence, and offers to close it.
// Only the decision to raise the check lives here; the asking is the skill's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegister, selectForThread } from "../lib/register.js";
import { checkDue, closeCheckLine, readChecks, markChecked } from "../lib/closecheck.js";
import { buildInjection } from "../lib/inject.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DAY = "2026-10-26";

const register = (fields = "") =>
  parseRegister(
    `Mission: ten artists on the platform\n\n## P1. Find out why sign-ups fell\n` +
      `- status: active\n- thread: topic:11\n- problem: sign-ups fell about 30%\n` +
      `- done when: the funnel step is named; both months compared\n` +
      `- confirmed: 2026-10-20 active\n- updated: 2026-10-24\n${fields}`,
  );

const sel = (fields) => selectForThread(register(fields), "topic:11");

test("the thread's active problem is due on the first turn of the day", () => {
  const due = checkDue(sel(), { date: DAY, checked: {} });
  assert.equal(due?.id, "P1");
});

test("it is not due a second time the same day", () => {
  assert.equal(checkDue(sel(), { date: DAY, checked: { P1: DAY } }), null);
});

test("yesterday's check does not count for today", () => {
  const due = checkDue(sel(), { date: DAY, checked: { P1: "2026-10-25" } });
  assert.equal(due?.id, "P1");
});

// The check ends in a question, and an automated turn has nobody to answer it.
test("an automated turn raises nothing", () => {
  assert.equal(checkDue(sel(), { date: DAY, checked: {}, actor: "automated" }), null);
});

// A second question on top of an unanswered one is how a thread stalls.
test("it waits while another question is pending", () => {
  assert.equal(checkDue(sel(`- pending: switch ${DAY}\n`), { date: DAY, checked: {} }), null);
});

test("a thread with no active problem raises nothing", () => {
  const none = selectForThread(parseRegister("Mission: m\n"), "topic:11");
  assert.equal(checkDue(none, { date: DAY, checked: {} }), null);
});

// Asking "is it done?" on the day the operator approved it is noise.
test("a problem confirmed active today is left alone", () => {
  const sameDay = selectForThread(
    parseRegister(
      `Mission: m\n\n## P1. Find out why sign-ups fell\n- status: active\n- thread: topic:11\n` +
        `- done when: the funnel step is named\n- confirmed: ${DAY} active\n- updated: ${DAY}\n`,
    ),
    "topic:11",
  );
  assert.equal(checkDue(sameDay, { date: DAY, checked: {} }), null);
});

// With no check written down there is nothing to compare evidence against;
// that is a lint error on the entry, not a close-check.
test("an active problem with no done-when raises nothing", () => {
  const noCheck = selectForThread(
    parseRegister(`Mission: m\n\n## P1. Vague\n- status: active\n- thread: topic:11\n- updated: 2026-10-01\n`),
    "topic:11",
  );
  assert.equal(checkDue(noCheck, { date: DAY, checked: {} }), null);
});

test("a mark survives to the next read, and a missing file reads as no marks", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "aps-chk-")), "state", "a.checks.json");
  assert.deepEqual(await readChecks(file), {});
  await markChecked(file, "P1", DAY);
  assert.deepEqual(await readChecks(file), { P1: DAY });
});

// Only today's date is ever compared, so yesterday's marks are dead weight.
test("marking drops the marks from earlier days", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "aps-chk-")), "a.checks.json");
  await markChecked(file, "P1", "2026-10-25");
  await markChecked(file, "P2", DAY);
  assert.deepEqual(await readChecks(file), { P2: DAY });
});

test("two problems checked on the same day both stay marked", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "aps-chk-")), "a.checks.json");
  await markChecked(file, "P1", DAY);
  await markChecked(file, "P2", DAY);
  assert.deepEqual(await readChecks(file), { P1: DAY, P2: DAY });
});

// A corrupt state file must cost the agent a check, never its turn.
test("an unreadable state file reads as no marks", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "aps-chk-")), "a.checks.json");
  writeFileSync(file, "{not json");
  assert.deepEqual(await readChecks(file), {});
  await markChecked(file, "P1", DAY);
  assert.deepEqual(await readChecks(file), { P1: DAY });
});

// The line is what a model that never opens the skill still has in front of it,
// so the three options and the operator's veto have to be in it.
test("the line names the evidence, the three options and who decides", () => {
  const line = closeCheckLine(checkDue(sel(), { date: DAY, checked: {} }));
  assert.match(line, /P1/);
  assert.match(line, /done-when/);
  assert.match(line, /close-problem skill/);
  assert.match(line, /1\. Done 2\. Drop 3\. Keep open/);
  assert.match(line, /still open/);
  assert.ok(Math.ceil(line.length / 4) <= 95, `${Math.ceil(line.length / 4)} tokens`);
});

test("the reminder carries the line only when a check is due", () => {
  const o = { thread: "topic:11", actor: "person", includeGauge: false };
  const due = checkDue(sel(), { date: DAY, checked: {} });
  assert.match(buildInjection(register(), { ...o, closeCheck: due }), /Close-check/);
  assert.doesNotMatch(buildInjection(register(), o), /Close-check/);
});

// The check is one more line on an already-full block, and the whole block is
// paid for on every turn of the day it goes out on.
test("the block stays bounded on the day the check goes out", () => {
  const worst = parseRegister(
    `Mission: ten words about the one outcome this agent exists for\n${Array.from({ length: 7 }, (_, i) =>
      `## P${i + 1}. Problem number ${i + 1} with a reasonably long action title\n- status: ${i < 5 ? "active" : i === 5 ? "parked" : "proposed"}\n- problem: ${"word ".repeat(25)}\n- done when: ${"check ".repeat(20)}\n- state: ${"state ".repeat(15)}\n- thread: topic:${i + 1}\n- updated: 2026-10-13\n`,
    ).join("\n")}`,
  );
  const due = checkDue(selectForThread(worst, "topic:1"), { date: DAY, checked: {} });
  const text = buildInjection(worst, {
    thread: "topic:1",
    reading: { tokens: 520_000, fresh: false, known: true },
    apsCommand: "node /opt/aps/bin/aps.mjs --overlay /srv/overlay --agent assistant",
    closeCheck: due,
  });
  assert.ok(Math.ceil(text.length / 4) <= 420, `${Math.ceil(text.length / 4)} tokens`);
});
