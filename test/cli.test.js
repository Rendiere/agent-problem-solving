import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readLog, today } from "../lib/ledger.js";
import { overlay, reg, P } from "./helpers.js";

const run = promisify(execFile);
const APS = new URL("../bin/aps.mjs", import.meta.url).pathname;
const TODAY = today();

async function aps(root, agent, args, { expectFail = false } = {}) {
  try {
    const r = await run(process.execPath, [APS, ...args], { env: { ...process.env, APS_OVERLAY: root, APS_AGENT: agent } });
    if (expectFail) assert.fail(`expected a failure, got:\n${r.stdout}`);
    return r;
  } catch (err) {
    if (!expectFail) assert.fail(`aps ${args.join(" ")} failed: ${err.stderr || err.message}`);
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
  }
}

const readReg = (root, agent) => readFileSync(path.join(root, "agents", agent, "PROBLEMS.md"), "utf8");
const logOf = (root, agent) => path.join(root, "agents", agent, "decisions.jsonl");

test("aps set changes a status, stamps the date and logs it once", async () => {
  const root = overlay({ a: reg(P("P1", { title: "Fix it", status: "proposed", thread: "topic:9", done_when: "it works" })) });
  const { stdout } = await aps(root, "a", ["set", "P1", "status=active", `confirmed=${TODAY}`]);
  assert.match(stdout, /logged opened on P1/);
  const text = readReg(root, "a");
  assert.match(text, /- status: active/);
  assert.match(text, new RegExp(`- updated: ${TODAY}`));
  const lines = await readLog(logOf(root, "a"));
  assert.equal(lines.filter((l) => l.kind === "opened").length, 1);
  assert.equal(lines[0].source, "aps set");
});

test("one aps set followed by a hook run gives exactly one log line", async () => {
  const root = overlay({ a: reg(P("P1", { title: "Fix it", status: "proposed", thread: "topic:9", done_when: "x" })) });
  await aps(root, "a", ["set", "P1", "status=active", `confirmed=${TODAY}`]);
  const plugin = (await import("../index.js")).default;
  let handler;
  plugin.register({
    pluginConfig: { overlayPath: root },
    on: (n, fn) => { if (n === "before_prompt_build") handler = fn; },
    runtime: { agent: { session: { getSessionEntry: () => ({ totalTokens: 1000 }) } } },
  });
  await handler({ prompt: "hi" }, { agentId: "a", sessionKey: "agent:a:telegram:group:-1:topic:9", trigger: "user", runId: "6cac05bb-423c-4221-a8fa-62db8bb83c18" });
  const lines = await readLog(logOf(root, "a"));
  assert.equal(lines.filter((l) => l.kind === "opened" && l.problem === "P1").length, 1, JSON.stringify(lines, null, 1));
});

test("aps set refuses a second active problem on a thread that already holds one", async () => {
  const root = overlay({
    a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x" }) + "\n" + P("P2", { status: "proposed", thread: "topic:9", done_when: "y" })),
  });
  const { stderr } = await aps(root, "a", ["set", "P2", "status=active"], { expectFail: true });
  assert.match(stderr, /topic:9 has 2 active problems \(P1, P2\)/i);
  assert.match(readReg(root, "a"), /## P2[\s\S]*- status: proposed/);
});

test("aps set refuses a second active problem when the thread holds a blocked one", async () => {
  const root = overlay({
    a: reg(P("P1", { status: "blocked", thread: "topic:9" }) + "\n" + P("P2", { status: "proposed", thread: "topic:9", done_when: "y" })),
  });
  const { stderr } = await aps(root, "a", ["set", "P2", "status=active"], { expectFail: true });
  assert.match(stderr, /P1 is blocked there/);
});

test("aps set refuses an unknown status and a blank thread", async () => {
  const root = overlay({ a: reg(P("P1", { status: "proposed", thread: "topic:9", done_when: "x" }) + "\n" + P("P2", { status: "proposed", done_when: "y" })) });
  assert.match((await aps(root, "a", ["set", "P1", "status=finished"], { expectFail: true })).stderr, /unknown status 'finished'/);
  assert.match((await aps(root, "a", ["set", "P2", "status=active"], { expectFail: true })).stderr, /has no thread/);
});

test("a side task going active pauses its parent, and closing it resumes the parent", async () => {
  const root = overlay({
    a: reg(
      P("P1", { title: "Email ten artists", status: "active", thread: "topic:9", done_when: "ten sent" }) + "\n" +
      P("P2", { title: "Find fifty addresses", status: "proposed", parent: "P1", thread: "topic:9", done_when: "fifty found" }),
    ),
  });
  await aps(root, "a", ["set", "P2", "status=active", `confirmed=${TODAY}`]);
  let text = readReg(root, "a");
  assert.match(text, /## P1[\s\S]*?- status: paused/);
  assert.match(text, /## P2[\s\S]*?- status: active/);

  await aps(root, "a", ["set", "P2", "status=done", `confirmed=${TODAY}`]);
  text = readReg(root, "a");
  assert.match(text, /## P1[\s\S]*?- status: active/);
  const lines = await readLog(logOf(root, "a"));
  assert.ok(lines.some((l) => l.kind === "closed" && l.problem === "P2"));
  assert.ok(lines.some((l) => l.kind === "resumed" && l.problem === "P1"));
});

test("two aps set calls in quick succession both land", async () => {
  const root = overlay({
    a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x" }) + "\n" + P("P2", { status: "proposed", thread: "topic:8", done_when: "y" })),
  });
  await Promise.all([
    aps(root, "a", ["set", "P1", "state=paused for now"]),
    aps(root, "a", ["set", "P2", "status=active", `confirmed=${TODAY}`]),
  ]);
  const text = readReg(root, "a");
  assert.match(text, /- state: paused for now/);
  assert.match(text, /## P2[\s\S]*?- status: active/);
});

test("aps set clears a pending line and records the choice", async () => {
  const root = overlay({ a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x", pending: `drift ${TODAY}` })) });
  await aps(root, "a", ["set", "P1", "pending=", "state=back on the quest"]);
  assert.doesNotMatch(readReg(root, "a"), /- pending:/);
  const notice = (await readLog(logOf(root, "a"))).find((l) => l.kind === "drift notice");
  assert.equal(notice.outcome, "stay");
});

test("aps add drafts a proposed entry with the next id", async () => {
  const root = overlay({ a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x" })) });
  const { stdout } = await aps(root, "a", ["add", "Win the first ten artists", "thread=topic:9", "done-when=ten sent", "problem=nobody has heard of it"]);
  assert.match(stdout, /^P2 Win the first ten artists/);
  assert.match(readReg(root, "a"), /## P2\. Win the first ten artists[\s\S]*- status: proposed/);
});

test("aps lint reports every register and exits non-zero on a finding", async () => {
  const root = overlay({
    a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x" })),
    b: reg(P("P1", { status: "active", thread: "topic:9" })),
  });
  const ok = await aps(root, "a", ["lint", "--agent", "a"]);
  assert.match(ok.stdout, /a: clean/);
  const bad = await aps(root, "b", ["lint"], { expectFail: true });
  assert.match(bad.stdout, /done-when-missing/);
});

test("aps report lists a parked problem per agent and flags one untouched for eight days", async () => {
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
  const root = overlay({
    a: reg(P("P1", { title: "Referral links", status: "parked", thread: "topic:1", state: "copy drafted", updated: "2026-10-01" })),
    b: reg(P("P1", { title: "Pricing page", status: "parked", thread: "topic:2", state: "waiting on them", updated: "2026-10-02" })),
    c: reg(
      P("P1", { title: "Quote tool", status: "parked", thread: "topic:3", state: "blocked on the API", updated: "2026-10-03" }) + "\n" +
      P("P2", { title: "Stale work", status: "active", thread: "topic:4", done_when: "x", updated: old }),
    ),
  });
  const { stdout } = await aps(root, "a", ["report"]);
  for (const t of ["Referral links", "Pricing page", "Quote tool"]) assert.match(stdout, new RegExp(t));
  assert.match(stdout, /Active, untouched 7\+ days:/);
  assert.match(stdout, /P2 Stale work \(8d\)/);

  const json = JSON.parse((await aps(root, "a", ["report", "--json"])).stdout);
  assert.deepEqual(json.agents.map((x) => x.agent), ["a", "b", "c"]);
  assert.equal(json.agents[2].stale[0].id, "P2");
});

test("aps report lists a pending question older than a day", async () => {
  const root = overlay({ a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x", pending: "drift 2026-10-01" })) });
  assert.match((await aps(root, "a", ["report"])).stdout, /Waiting on an answer:[\s\S]*drift asked 2026-10-01/);
});

test("aps doctor reports each check and fails when the overlay is incomplete", async () => {
  const root = overlay({ a: reg(P("P1", { status: "active", thread: "topic:9", done_when: "x" })) });
  const r = await aps(root, "a", ["doctor"], { expectFail: true });
  assert.match(r.stdout, /^ok   overlay found/m);
  assert.match(r.stdout, /FAIL deny-list present/);
  assert.match(r.stdout, /^ok   a: register lint clean/m);
  assert.match(r.stdout, /^ok   a: reminder builds/m);
});

test("aps refuses to run with no overlay", async () => {
  try {
    await run(process.execPath, [APS, "report"], { env: { ...process.env, APS_OVERLAY: "", APS_AGENT: "a" } });
    assert.fail("expected a failure");
  } catch (err) {
    assert.match(err.stderr, /no overlay/);
  }
});
