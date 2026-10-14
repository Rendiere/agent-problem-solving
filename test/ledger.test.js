import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRegister } from "../lib/register.js";
import { appendLog, diffRegister, readLog, snapshotOf, today, withLock } from "../lib/ledger.js";
import { reg, P } from "./helpers.js";

const snap = (text) => snapshotOf(parseRegister(text));
const diff = (before, after) => diffRegister(snap(before), parseRegister(after));
const kinds = (entries) => entries.map((e) => e.kind);
const TODAY = today();

test("proposed to active with a same-day confirmed line is logged and not flagged", () => {
  const before = reg(P("P1", { status: "proposed", thread: "topic:5", done_when: "x" }));
  const after = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", confirmed: TODAY }));
  const e = diff(before, after);
  assert.deepEqual(kinds(e), ["opened"]);
  assert.equal(e[0].flag, undefined);
});

test("proposed to active with no confirmed line is logged and flagged", () => {
  const before = reg(P("P1", { status: "proposed", thread: "topic:5", done_when: "x" }));
  const after = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x" }));
  const e = diff(before, after);
  assert.deepEqual(kinds(e), ["opened", "status-change"]);
  assert.match(e[1].flag, /no confirmed: line/);
});

test("a confirmed line from another day is flagged", () => {
  const before = reg(P("P1", { status: "proposed", thread: "topic:5", done_when: "x" }));
  const after = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", confirmed: "2026-01-01" }));
  assert.match(diff(before, after).find((x) => x.flag).flag, /dated 2026-01-01, not today/);
});

test("a drift notice that clears while the problem is parked records the choice as park", () => {
  const before = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", pending: `drift ${TODAY}` }));
  const after = reg(P("P1", { status: "parked", thread: "topic:5", done_when: "x", state: "set aside" }));
  const e = diff(before, after);
  assert.ok(e.some((x) => x.kind === "parked"));
  const notice = e.find((x) => x.kind === "drift notice");
  assert.equal(notice.outcome, "park");
});

test("a drift notice that clears with the problem unchanged records the choice as stay", () => {
  const before = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", pending: `drift ${TODAY}` }));
  const after = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x" }));
  assert.equal(diff(before, after).find((x) => x.kind === "drift notice").outcome, "stay");
});

test("a reset offer cleared by a reset logs the offer with outcome reset", () => {
  const before = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", pending: `reset ${TODAY}` }));
  const after = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x" }));
  const e = diff(before, after).find((x) => x.kind === "reset offer");
  assert.equal(e.outcome, "reset");
});

test("raising a question logs it with no outcome yet", () => {
  const before = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x" }));
  const after = reg(P("P1", { status: "active", thread: "topic:5", done_when: "x", pending: `drift ${TODAY}` }));
  const e = diff(before, after).find((x) => x.kind === "drift notice");
  assert.equal(e.outcome, "");
});

test("a side task closing logs the close and the parent's resume", () => {
  const before = reg(
    P("P1", { status: "paused", thread: "topic:5", done_when: "ten sent" }) + "\n" +
    P("P2", { status: "active", parent: "P1", thread: "topic:5", done_when: "fifty found" }),
  );
  const after = reg(
    P("P1", { status: "active", thread: "topic:5", done_when: "ten sent", confirmed: TODAY }) + "\n" +
    P("P2", { status: "done", parent: "P1", thread: "topic:5", done_when: "fifty found", confirmed: TODAY }),
  );
  assert.deepEqual(kinds(diff(before, after)).sort(), ["closed", "resumed"]);
});

test("a park beside another problem going active on the same thread is a switch", () => {
  const before = reg(
    P("P1", { status: "active", thread: "topic:5", done_when: "x" }) + "\n" +
    P("P2", { status: "parked", thread: "topic:5", done_when: "y" }),
  );
  const after = reg(
    P("P1", { status: "parked", thread: "topic:5", done_when: "x", state: "waiting" }) + "\n" +
    P("P2", { status: "active", thread: "topic:5", done_when: "y", confirmed: TODAY }),
  );
  const e = diff(before, after);
  const sw = e.find((x) => x.kind === "switched");
  assert.equal(sw.problem, "P1");
  assert.equal(sw.to_problem, "P2");
  assert.ok(e.some((x) => x.kind === "resumed" && x.problem === "P2"));
});

test("an entry removed from the register is flagged, not silently dropped", () => {
  const e = diff(reg(P("P1", { status: "active", thread: "topic:5", done_when: "x" })), reg(""));
  assert.match(e[0].flag, /removed from the register/);
});

test("the log is append-only and every line parses", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-log-"));
  const file = path.join(dir, "decisions.jsonl");
  await appendLog(file, [{ kind: "opened", problem: "P1" }], { agent: "a", source: "test" });
  const head = readFileSync(file, "utf8");
  for (let i = 0; i < 50; i += 1) {
    await appendLog(file, [{ kind: "parked", problem: `P${i}` }], { agent: "a", source: "test" });
  }
  const text = readFileSync(file, "utf8");
  assert.equal(text.slice(0, head.length), head);
  const lines = await readLog(file);
  assert.equal(lines.length, 51);
  assert.ok(lines.every((l) => l.agent === "a" && l.at && l.date));
});

test("the lock serialises writers and is released on a thrown error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-lock-"));
  const order = [];
  await Promise.all([
    withLock(dir, "a", async () => { order.push("in1"); await new Promise((r) => setTimeout(r, 40)); order.push("out1"); }),
    withLock(dir, "a", async () => { order.push("in2"); order.push("out2"); }),
  ]);
  assert.ok(order.indexOf("out1") < order.indexOf("in2") || order.indexOf("out2") < order.indexOf("in1"), order.join(","));
  await assert.rejects(withLock(dir, "a", async () => { throw new Error("boom"); }), /boom/);
  await withLock(dir, "a", async () => order.push("after"));
  assert.ok(order.includes("after"));
});
