import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseRegister, lintRegister, selectForThread, threadFromSessionKey, threadMatches, STATUSES,
} from "../lib/register.js";
import { readRegister } from "../lib/store.js";
import { reg, P, overlay } from "./helpers.js";

const codes = (text) => lintRegister(parseRegister(text)).map((f) => f.code);

test("the template parses to an empty register", () => {
  const r = parseRegister(readFileSync(new URL("../templates/PROBLEMS.md", import.meta.url), "utf8"));
  assert.equal(r.problems.length, 0);
  assert.equal(r.mission, "");
});

test("every status in the list is a status, and nothing else is", () => {
  assert.deepEqual([...STATUSES], ["proposed", "active", "paused", "parked", "blocked", "done", "dropped"]);
});

test("a paused parent with an active side task in the same thread lints clean", () => {
  const text = reg(
    P("P1", { title: "Email the first ten artists", status: "paused", thread: "topic:5", done_when: "ten sent", updated: "2026-10-14" }) +
      "\n" +
      P("P2", { title: "Find fifty addresses", status: "active", parent: "P1", thread: "topic:5", done_when: "fifty found", updated: "2026-10-14" }),
  );
  assert.deepEqual(codes(text), []);
  const sel = selectForThread(parseRegister(text), "topic:5");
  assert.equal(sel.activeHere.id, "P2");
  assert.equal(sel.pausedParent.id, "P1");
  assert.equal(sel.state, "on-problem");
});

test("two active problems in one thread is a lint error", () => {
  const text = reg(
    P("P1", { status: "active", thread: "topic:5", done_when: "x" }) + "\n" + P("P2", { status: "active", thread: "topic:5", done_when: "y" }),
  );
  assert.ok(codes(text).includes("thread-two-active"));
});

test("an active problem beside a blocked one in the same thread is a lint error", () => {
  const text = reg(
    P("P1", { status: "blocked", thread: "topic:5" }) + "\n" + P("P2", { status: "active", thread: "topic:5", done_when: "y" }),
  );
  assert.ok(codes(text).includes("thread-active-and-blocked"));
});

test("a blocked problem keeps the thread's slot", () => {
  const sel = selectForThread(parseRegister(reg(P("P1", { status: "blocked", thread: "topic:5", state: "waiting on their reply" }))), "topic:5");
  assert.equal(sel.state, "blocked");
  assert.equal(sel.activeHere, null);
  assert.equal(sel.blockedHere[0].id, "P1");
});

test("an unknown status is reported, not coerced", () => {
  const r = parseRegister(reg(P("P1", { status: "finished", thread: "topic:5" })));
  assert.equal(r.problems[0].status, "finished");
  assert.equal(r.problems[0].unknownStatus, true);
  assert.ok(lintRegister(r).some((f) => f.code === "status-unknown" && /finished/.test(f.message)));
});

test("links parse as a list", () => {
  const r = parseRegister(reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", links: "LIN-12, JIRA-4" })));
  assert.deepEqual(r.problems[0].links, ["LIN-12", "JIRA-4"]);
});

test("a blank thread is a lint error and the entry is active nowhere", () => {
  const text = reg(P("P1", { status: "active", done_when: "x" }) + "\n" + P("P2", { status: "active", thread: "topic:5", done_when: "y" }));
  assert.ok(codes(text).includes("thread-blank"));
  const r = parseRegister(text);
  for (const thread of ["topic:5", "topic:9", "any", ""]) {
    const sel = selectForThread(r, thread);
    assert.notEqual(sel.activeHere?.id, "P1", `P1 went active on ${thread}`);
  }
  assert.deepEqual(selectForThread(r, "topic:5").unthreaded.map((p) => p.id), ["P1"]);
});

test("an active problem with no done-when is a lint error", () => {
  assert.ok(codes(reg(P("P1", { status: "active", thread: "topic:5" }))).includes("done-when-missing"));
});

test("a missing mission line is a lint error", () => {
  assert.ok(lintRegister(parseRegister(P("P1", { status: "proposed", thread: "topic:5" }))).some((f) => f.code === "mission-missing"));
});

test("a paused problem with no active side task is a lint error", () => {
  assert.ok(codes(reg(P("P1", { status: "paused", thread: "topic:5" }))).includes("paused-without-active-child"));
});

test("pending, confirmed and the counts parse as named fields", () => {
  const r = parseRegister(reg(P("P1", {
    status: "active", thread: "topic:5", done_when: "x",
    pending: "drift 2026-10-14", confirmed: "2026-10-13", pushbacks: "2", corrections: "1",
  })));
  const p = r.problems[0];
  assert.deepEqual({ kind: p.pending.kind, date: p.pending.date, known: p.pending.known }, { kind: "drift", date: "2026-10-14", known: true });
  assert.equal(p.confirmed.date, "2026-10-13");
  assert.equal(p.pushbacks, 2);
  assert.equal(p.corrections, 1);
});

test("an unknown pending kind is a lint error", () => {
  assert.ok(codes(reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", pending: "ponder 2026-10-14" }))).includes("pending-unknown"));
});

test("nested bullets are notes, and status notes and done-when spellings are tolerated", () => {
  const r = parseRegister("Mission: m\n\n## P1. A\n- status: Active (since 10 Oct)\n- done-when: it works\n  - note: nested\n- thread: topic:1\n");
  assert.equal(r.problems[0].status, "active");
  assert.equal(r.problems[0].fields["done when"], "it works");
  assert.equal(r.problems[0].fields.note, undefined);
});

test("a thread is read out of a session key", () => {
  assert.equal(threadFromSessionKey("agent:alpha:telegram:group:-1000:topic:42"), "topic:42");
  assert.ok(threadMatches("topic:42", "topic:42"));
  assert.ok(threadMatches("42, topic:7", "topic:7"));
  assert.ok(!threadMatches("topic:4", "topic:42"));
  assert.ok(threadMatches("any", "topic:1"));
  assert.ok(!threadMatches("", "topic:1"));
});

test("an unreadable file gives the degraded notice instead of throwing", async () => {
  const root = overlay({ a: reg(P("P1", { status: "active", thread: "topic:5", done_when: "x" })) });
  const file = path.join(root, "agents", "a", "PROBLEMS.md");
  chmodSync(file, 0o000);
  const r = await readRegister({ overlayPath: root }, "a");
  chmodSync(file, 0o644);
  assert.equal(r.ok, false);
  assert.match(r.degraded, /permission/);
});

test("a missing agent folder and a missing overlay each give the degraded notice", async () => {
  const root = overlay({});
  const missingAgent = await readRegister({ overlayPath: root }, "nobody");
  assert.equal(missingAgent.ok, false);
  assert.match(missingAgent.degraded, /no file at/);
  const noOverlay = await readRegister({}, "a");
  assert.equal(noOverlay.ok, false);
  assert.match(noOverlay.degraded, /overlayPath/);
});

test("a duplicate problem id is a lint error", () => {
  assert.ok(codes(reg(P("P1", { status: "proposed", thread: "topic:5" }) + "\n" + P("P1", { status: "proposed", thread: "topic:6" }))).includes("duplicate-id"));
});

test("a parent that is not in the register is a lint error", () => {
  assert.ok(codes(reg(P("P2", { status: "active", thread: "topic:5", done_when: "x", parent: "P9" }))).includes("parent-unknown"));
});
