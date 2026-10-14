import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseRegister } from "../lib/register.js";
import { buildInjection, buildShortInjection } from "../lib/inject.js";
import { reg, P } from "./helpers.js";

const src = (text) => ({ register: parseRegister(text) });
const chars = (t) => t.length;
const TOKENS = (t) => Math.round(t.length / 4);

const ACTIVE = reg(
  P("P4", {
    title: "Win the first ten artists", status: "active", thread: "topic:5",
    problem: "No artist has heard of the product yet.",
    done_when: "ten personalised emails are approved and sent",
    rules_out: "privacy-page polish", updated: "2026-10-14",
  }),
);

test("no entries shows no problem and the entry instruction", () => {
  const t = buildInjection(src(reg("")), { thread: "topic:5" });
  assert.match(t, /Thread topic:5 — no problem\./);
  assert.match(t, /draft the register entry/);
  assert.doesNotMatch(t, /Check before you reply/);
});

test("a proposed entry shows awaiting confirmation and no work instruction", () => {
  const t = buildInjection(src(reg(P("P1", { status: "proposed", thread: "topic:5", done_when: "x" }))), { thread: "topic:5" });
  assert.match(t, /awaiting confirmation on P1/);
  assert.match(t, /Do not start the work until they confirm/);
  assert.doesNotMatch(t, /Check before you reply/);
});

test("an active problem shows its done-when and the check", () => {
  const t = buildInjection(src(ACTIVE), { thread: "topic:5", reading: 120_000 });
  assert.match(t, /on P4 Win the first ten artists/);
  assert.match(t, /Done when: ten personalised emails/);
  assert.match(t, /Check before you reply/);
  assert.match(t, /Park P4 \(<its state>\) and switch\?/);
  assert.match(t, /veering off P4/);
});

test("an active side task names its paused parent", () => {
  const t = buildInjection(
    src(reg(
      P("P1", { title: "Email ten artists", status: "paused", thread: "topic:5", done_when: "ten sent" }) + "\n" +
      P("P2", { title: "Find fifty addresses", status: "active", parent: "P1", thread: "topic:5", done_when: "fifty found" }),
    )),
    { thread: "topic:5" },
  );
  assert.match(t, /on P2 Find fifty addresses/);
  assert.match(t, /Paused parent: P1 Email ten artists/);
  assert.match(t, /resumes when this one closes/);
});

test("an open pending drift line is the stop line, and crowds out every other prompt", () => {
  const t = buildInjection(
    src(reg(P("P4", { status: "active", thread: "topic:5", done_when: "ten sent", pending: "drift 2026-10-14" }))),
    { thread: "topic:5" },
  );
  assert.match(t, /WAITING for the person's answer to the drift notice on P4 \(asked 2026-10-14\)/);
  assert.match(t, /Do no work on P4 until they answer/);
  assert.doesNotMatch(t, /Check before you reply/);
  // The stop line is the last thing the agent reads.
  assert.ok(t.lastIndexOf("WAITING") > t.indexOf("Context:"));
});

test("an active problem with no done-when says so instead of staying silent", () => {
  const t = buildInjection(src(reg(P("P4", { status: "active", thread: "topic:5" }))), { thread: "topic:5" });
  assert.match(t, /Done when: NOT SET/);
});

test("a blocked problem holds the thread and nothing else goes active", () => {
  const t = buildInjection(src(reg(P("P1", { status: "blocked", thread: "topic:5", state: "waiting on their reply" }))), { thread: "topic:5" });
  assert.match(t, /is BLOCKED and still holds this thread/);
  assert.match(t, /Nothing else goes active here/);
});

test("the degraded notice tells the agent to say so and not assume no problem", () => {
  const t = buildInjection({ ok: false, degraded: "no permission to read /x/PROBLEMS.md" }, { thread: "topic:5" });
  assert.match(t, /Problem register unreadable: no permission/);
  assert.match(t, /Tell the person this in one line/);
  assert.match(t, /do not treat it as 'no active problem'/);
});

test("five threads with active problems, one parked and one proposed stay near 300 tokens", () => {
  const body = [
    P("P1", { title: "Win the first ten artists", status: "active", thread: "topic:1", problem: "No artist has heard of the product yet.", done_when: "ten personalised emails are approved and sent", rules_out: "privacy-page polish", updated: "2026-10-14" }),
    P("P2", { title: "Ship the quote tool", status: "active", thread: "topic:2", done_when: "a quote lands in the inbox", updated: "2026-10-14" }),
    P("P3", { title: "Fix the booking link", status: "active", thread: "topic:3", done_when: "every email joins the right booking", updated: "2026-10-14" }),
    P("P4", { title: "Rebuild the planter", status: "active", thread: "topic:4", done_when: "the planter stands", updated: "2026-10-14" }),
    P("P5", { title: "Move the tax registration", status: "active", thread: "topic:5", done_when: "the form is filed", updated: "2026-10-14" }),
    P("P6", { title: "Referral links", status: "parked", thread: "topic:1", state: "copy drafted, no code", updated: "2026-10-13" }),
    P("P7", { title: "Pricing page", status: "proposed", thread: "topic:1", done_when: "the page is live", updated: "2026-10-14" }),
  ].join("\n");
  const t = buildInjection(src(reg(body)), { thread: "topic:1", reading: 120_000 });
  assert.ok(TOKENS(t) <= 330, `${TOKENS(t)} tokens / ${chars(t)} chars:\n${t}`);
  assert.match(t, /Other threads: /);
  assert.match(t, /Last parked: P6/);
});

test("the short block for an automated turn stays under 120 tokens and asks nothing", () => {
  const t = buildShortInjection(src(ACTIVE), { thread: "topic:5", reading: 120_000 });
  assert.ok(TOKENS(t) < 120, `${TOKENS(t)} tokens:\n${t}`);
  assert.match(t, /on P4 Win the first ten artists/);
  assert.match(t, /ask them nothing/);
  assert.match(t, /pending: <kind>/);
  assert.doesNotMatch(t, /Check before you reply/);
  assert.doesNotMatch(t, /and switch\?/);
});

test("a heartbeat during an active problem gets no prompt instructions (AE5)", () => {
  const t = buildInjection(src(ACTIVE), { thread: "topic:5", reading: 120_000, automated: true });
  assert.match(t, /ask them nothing/);
  assert.doesNotMatch(t, /Check before you reply/);
  assert.doesNotMatch(t, /veering off/);
});

test("nothing in the core tells the agent to switch unasked or answer before asking", () => {
  const files = [
    "lib/inject.js",
    ...readdirSync(new URL("../skills", import.meta.url)).map((d) => `skills/${d}/SKILL.md`),
  ];
  const bad = [
    /follow (?:the person|them|him|her|it) (?:first|straight away)/i,
    /answer (?:first|in two lines at most),? then ask/i,
    /answer\b[^.\n]{0,40}\bbefore (?:you )?ask/i,
    /don't argue/i,
    /do not argue/i,
    /switch without asking/i,
  ];
  for (const f of files) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    for (const re of bad) assert.doesNotMatch(text, re, `${f} matches ${re}`);
  }
});

test("no overlay identifier is hard-coded in the reminder", () => {
  const text = readFileSync(new URL("../lib/inject.js", import.meta.url), "utf8");
  assert.doesNotMatch(text, /\bRen\b/);
  assert.doesNotMatch(text, /topic:\d{3,}/);
});
