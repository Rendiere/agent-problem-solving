import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLedger } from "../lib/ledger.js";
import { parseRegister } from "../lib/register.js";
import { today } from "../lib/gauge.js";

const APS = new URL("../bin/aps.mjs", import.meta.url).pathname;
const DAY = today();

// Point the session reader at an empty state directory: the report must not
// depend on which sessions this machine happens to be running.
const STATE = mkdtempSync(path.join(tmpdir(), "aps-state-"));

function aps(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [APS, ...args], { env: { ...process.env, OPENCLAW_STATE_DIR: STATE, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

function overlay(registers) {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-cli-"));
  for (const [agent, text] of Object.entries(registers)) {
    mkdirSync(path.join(dir, "agents", agent), { recursive: true });
    writeFileSync(path.join(dir, "agents", agent, "PROBLEMS.md"), text);
  }
  return dir;
}

const entry = (id, title, fields) => `## ${id}. ${title}\n${Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`;

const ONE = `Mission: one line about the outcome\n\n${entry("P1", "First problem", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active`, updated: DAY })}\n${entry("P2", "Second problem", { status: "proposed", thread: "topic:1" })}`;

test("set stamps the date, logs the change and keeps the rest of the file", async () => {
  const dir = overlay({ a: ONE });
  const r = await aps(["set", "P1", "state=waiting on the clinic", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.match(text, /- state: waiting on the clinic/);
  assert.match(text, /- updated: \d{4}-\d{2}-\d{2}/);
  assert.match(text, /## P2\. Second problem/);
});

test("set rejects an unknown status", async () => {
  const dir = overlay({ a: ONE });
  const r = await aps(["set", "P1", "status=finished", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown status "finished"/);
});

test("set refuses a second active problem in the same thread", async () => {
  const dir = overlay({ a: ONE });
  const r = await aps(["set", "P2", "status=active", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already holds P1 \(active\)/);
});

test("set refuses to make an entry with no thread active", async () => {
  const dir = overlay({ a: `Mission: m\n\n${entry("P9", "Loose", { status: "proposed" })}` });
  const r = await aps(["set", "P9", "status=active", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /has no thread/);
});

test("a side task takes the thread and pauses its parent; closing it hands the thread back", async () => {
  const dir = overlay({ a: `${ONE}\n${entry("P3", "Side task", { status: "proposed", thread: "topic:1", parent: "P1", "done when": "the script runs" })}` });
  const file = path.join(dir, "agents", "a", "PROBLEMS.md");
  let r = await aps(["set", "P3", "status=active", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  let text = readFileSync(file, "utf8");
  assert.match(text.split("## P1.")[1], /- status: paused/);
  assert.match(text.split("## P3.")[1], /- status: active/);

  r = await aps(["set", "P3", "status=done", "learned=one line", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  text = readFileSync(file, "utf8");
  assert.match(text.split("## P1.")[1], /- status: active/);
  // The operator's yes to the close covers the parent coming back, so the
  // resume carries today's confirmation and the report does not flag it.
  assert.match(text.split("## P1.")[1], new RegExp(`- confirmed: ${DAY} resumed`));
  const rows = await readLedger(path.join(dir, "agents", "a", "decisions.jsonl"));
  assert.deepEqual(rows.filter((e) => e.flag).map((e) => `${e.problem}: ${e.flag}`), [], "a normal side-task close flags nothing");
  const kinds = rows.map((e) => `${e.problem}:${e.kind}`);
  assert.ok(kinds.includes("P3:closed"), kinds.join(","));
  assert.ok(kinds.includes("P1:switched"), kinds.join(","));
  assert.ok(kinds.includes("P1:paused"), kinds.join(","));
});

test("two set calls in quick succession both land", async () => {
  const dir = overlay({ a: ONE });
  const [x, y] = await Promise.all([
    aps(["set", "P1", "pushbacks=1", "--agent", "a"], { APS_OVERLAY: dir }),
    aps(["set", "P2", "state=drafted", "--agent", "a"], { APS_OVERLAY: dir }),
  ]);
  assert.equal(x.code, 0, x.stderr);
  assert.equal(y.code, 0, y.stderr);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.match(text, /- pushbacks: 1/);
  assert.match(text, /- state: drafted/);
});

test("one set followed by a hook-style diff gives exactly one log line", async () => {
  const dir = overlay({ a: ONE });
  const r = await aps(["set", "P2", "status=parked", "state=not now", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  const { logHandEdits } = await import("../lib/ledger.js");
  const extra = await logHandEdits({
    registerFile: path.join(dir, "agents", "a", "PROBLEMS.md"),
    snapshotFile: path.join(dir, "state", "a.snapshot.json"),
    ledgerFile: path.join(dir, "agents", "a", "decisions.jsonl"),
    agent: "a",
    actor: "person",
  });
  assert.deepEqual(extra, []);
  const rows = await readLedger(path.join(dir, "agents", "a", "decisions.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "parked");
  assert.equal(rows[0].source, "aps");
});

test("lint reports the rule it broke and exits 1", async () => {
  const dir = overlay({ a: `Mission: m\n\n${entry("P1", "a", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` })}\n${entry("P2", "b", { status: "active", thread: "topic:1", "done when": "y", confirmed: `${DAY} active` })}` });
  const r = await aps(["lint", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /holds 2 active problems/);
});

test("lint passes on the seeded register", async () => {
  const dir = overlay({ a: ONE });
  const r = await aps(["lint", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /clean/);
});

test("report covers three agents, each parked problem and a stale one", async () => {
  const stale = "2026-01-01";
  const dir = overlay({
    a: `Mission: m\n\n${entry("P1", "Alpha parked", { status: "parked", thread: "topic:1", state: "waiting", updated: DAY })}\n${entry("P2", "Alpha stale", { status: "active", thread: "topic:2", "done when": "x", confirmed: `${stale} active`, updated: stale })}`,
    b: `Mission: m\n\n${entry("P1", "Bravo parked", { status: "parked", thread: "topic:3", updated: DAY })}`,
    c: `Mission: m\n\n${entry("P1", "Charlie parked", { status: "parked", thread: "topic:4", updated: DAY })}\n${entry("P2", "Charlie waiting", { status: "active", thread: "topic:5", "done when": "y", pending: "drift 2026-01-02", confirmed: `${DAY} active`, updated: DAY })}`,
  });
  const r = await aps(["report"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  for (const name of ["Alpha parked", "Bravo parked", "Charlie parked"]) assert.match(r.stdout, new RegExp(name));
  assert.match(r.stdout, /untouched 7\+ days: P2 Alpha stale/);
  assert.match(r.stdout, /waiting on an answer: P2 drift/);
  assert.match(r.stdout, /largest live session/);

  const j = await aps(["report", "--json"], { APS_OVERLAY: dir });
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.agents.length, 3);
  assert.equal(parsed.agents[0].parked[0].id, "P1");
});

test("no overlay is an error, not a stack trace", async () => {
  const r = await aps(["lint"], { APS_OVERLAY: "" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no overlay/);
});

test("a rejected set leaves no lock behind", async () => {
  const dir = overlay({ a: ONE });
  const bad = await aps(["set", "P2", "status=active", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(bad.code, 2);
  // A lock left by a rejected call would stall the next call and every hook
  // turn for as long as it took to go stale, so assert on the lock itself
  // rather than on how long the next call took: on a slow machine process
  // start-up swamps the lock wait and the timing says nothing.
  const locks = existsSync(path.join(dir, "state")) ? readdirSync(path.join(dir, "state")).filter((n) => n.includes(".lock")) : [];
  assert.deepEqual(locks, []);
  const ok = await aps(["set", "P2", "state=still proposed", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(ok.code, 0, ok.stderr);
});

test("set refuses to move an active problem into an occupied thread", async () => {
  const dir = overlay({
    a: `${ONE}\n${entry("P3", "Elsewhere", { status: "active", thread: "topic:2", "done when": "z", confirmed: `${DAY} active`, updated: DAY })}`,
  });
  const r = await aps(["set", "P3", "thread=topic:1", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already holds P1 \(active\)/);
});

test("an odd field name is still the field it looks like", async () => {
  const dir = overlay({ a: ONE });
  const r = await aps(["set", "P2", "status =finished", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown status "finished"/);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.equal((text.match(/- status:/g) ?? []).length, 2, "nothing was written");
});

test("set edits the line the parser reads when a field is repeated", async () => {
  const dir = overlay({ a: `Mission: m\n\n${entry("P1", "Repeated", { status: "parked", thread: "topic:1" })}- status: parked\n` });
  const r = await aps(["set", "P1", "status=dropped", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.equal((text.match(/- status:/g) ?? []).length, 1);
  assert.match(text, /- status: dropped/);
  assert.match(r.stdout, /P1 dropped/);
});

test("the template lints clean", async () => {
  const dir = overlay({ a: readFileSync(new URL("../templates/PROBLEMS.md", import.meta.url), "utf8") });
  const r = await aps(["lint", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /clean/);
});

test("lint --all skips an agent folder with no register", async () => {
  const dir = overlay({ a: ONE });
  mkdirSync(path.join(dir, "agents", "b"), { recursive: true });
  const r = await aps(["lint", "--all"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /^b /m);
});

test("report treats a missing date as overdue, not as fresh", async () => {
  const dir = overlay({
    a: `Mission: m\n\n${entry("P1", "No date", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` })}\n${entry("P2", "Open question", { status: "parked", thread: "topic:2", pending: "drift" })}`,
  });
  const r = await aps(["report", "--agents", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /untouched 7\+ days: P1 No date \(no date\)/);
  assert.match(r.stdout, /waiting on an answer: P2 drift \(no date\)/);
});

test("report counts the operator's turns above the warning level, not the automated ones", async () => {
  const dir = overlay({ a: ONE });
  const { recordTurn } = await import("../lib/ledger.js");
  const turns = path.join(dir, "agents", "a", "turns.json");
  await recordTurn(turns, { day: DAY, actor: "person", level: "warn" });
  await recordTurn(turns, { day: DAY, actor: "person", level: "ok" });
  await recordTurn(turns, { day: DAY, actor: "automated", level: "high" });
  const r = await aps(["report", "--agents", "a"], { APS_OVERLAY: dir });
  assert.match(r.stdout, /2 from the operator, 1 automated, 50% of theirs above the warning level/);
});

test("set refuses a second active problem when an any-thread entry holds the slot", async () => {
  const dir = overlay({
    a: `Mission: m\n\n${entry("P1", "Everywhere", { status: "active", thread: "any", "done when": "x", confirmed: `${DAY} active`, updated: DAY })}\n${entry("P2", "Mine", { status: "proposed", thread: "topic:1", "done when": "y" })}`,
  });
  const r = await aps(["set", "P2", "status=active", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /already holds P1 \(active\)/);
});

test("set refuses a second active problem when the holder names several threads", async () => {
  const dir = overlay({
    a: `Mission: m\n\n${entry("P1", "Two threads", { status: "active", thread: "topic:1, topic:2", "done when": "x", confirmed: `${DAY} active`, updated: DAY })}\n${entry("P2", "Mine", { status: "proposed", thread: "topic:2", "done when": "y" })}`,
  });
  const r = await aps(["set", "P2", "status=active", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /already holds P1 \(active\)/);
});

test("set changes the status the parser reads in a register with CRLF line endings", async () => {
  const dir = overlay({ a: "Mission: m\r\n\r\n## P1. Windows\r\n- status: proposed\r\n- thread: topic:1\r\n- done when: x\r\n" });
  const r = await aps(["set", "P1", "status=parked", "state=held", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.equal(parseRegister(text).problems[0].status, "parked", text.replace(/\r/g, "<CR>"));
  const mixed = text.split("\n").slice(0, -1).filter((l) => !l.endsWith("\r"));
  assert.deepEqual(mixed, [], "the file keeps one kind of line ending");
  assert.match(r.stdout, /P1 parked/);
});

test("set refuses an id that appears twice rather than editing the wrong one", async () => {
  const dir = overlay({
    a: `Mission: m\n\n${entry("P1", "First", { status: "parked", thread: "topic:1" })}\n${entry("P1", "Second", { status: "parked", thread: "topic:2" })}`,
  });
  const r = await aps(["set", "P1", "status=dropped", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /P1 appears twice/);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.doesNotMatch(text, /dropped/, "nothing was written");
});

test("set refuses a change that would break a rule the register has to keep", async () => {
  const dir = overlay({ a: `Mission: m\n\n${entry("P9", "No done-when", { status: "proposed", thread: "topic:9" })}` });
  const r = await aps(["set", "P9", "status=active", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /done when/);
  assert.match(readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8"), /- status: proposed/);
});

// --------------------------------------------------------------- the pin

const PINNED = `Mission: one line about the outcome\n\n${entry("P1", "First problem", {
  status: "active",
  thread: "topic:1",
  "done when": "x",
  pin: "4211",
  confirmed: `${DAY} active`,
  updated: DAY,
})}`;

test("closing a problem tells the agent to unpin its 📌 message and how to clear the field", async () => {
  const dir = overlay({ a: PINNED });
  const r = await aps(["set", "P1", "status=done", "learned=one line", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /unpin: message 4211 in topic:1 is still pinned for P1/);
  assert.match(r.stdout, /set P1 pin=/);
  // The id stays on the entry until the unpin lands, so a failed unpin is still
  // on the record rather than lost with the status change.
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.equal(parseRegister(text).problems[0].pin, "4211");
});

test("dropping and parking name the pin too; an ordinary field change does not", async () => {
  for (const status of ["dropped", "parked"]) {
    const dir = overlay({ a: PINNED });
    const args = ["set", "P1", `status=${status}`, "state=held", "--agent", "a"];
    if (status === "dropped") args.push("--confirmed");
    const r = await aps(args, { APS_OVERLAY: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /unpin: message 4211/, `${status} said nothing about the pin`);
  }
  const dir = overlay({ a: PINNED });
  const r = await aps(["set", "P1", "state=still going", "--agent", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /unpin:/);
});

test("clearing the pin in the same call as the close says nothing more about it", async () => {
  const dir = overlay({ a: PINNED });
  const r = await aps(["set", "P1", "status=done", "pin=", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /unpin:/);
  const text = readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8");
  assert.equal(parseRegister(text).problems[0].pin, "");
  assert.doesNotMatch(text, /- pin:/);
});

test("set --json carries the unpin for a runtime that posts it", async () => {
  const dir = overlay({ a: PINNED });
  const r = await aps(["set", "P1", "status=done", "--agent", "a", "--confirmed", "--json"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.unpin.messageId, "4211");
  assert.equal(out.unpin.thread, "topic:1");
  assert.ok(Array.isArray(out.logged));
});

test("report names a problem that ended with its pin still up, and lint warns about it the next day", async () => {
  const stale = `Mission: one line about the outcome\n\n${entry("P1", "First problem", { status: "done", thread: "topic:1", pin: "4211", learned: "one line", confirmed: "2026-10-01 done", updated: "2026-10-01" })}`;
  const dir = overlay({ a: stale });
  const r = await aps(["report", "--agents", "a"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /still pinned after the problem ended: P1 message 4211 in topic:1 \(done\)/);
  assert.doesNotMatch(r.stdout, /pins: not checked/);
  const l = await aps(["lint", "--agent", "a"], { APS_OVERLAY: dir });
  assert.match(l.stdout + l.stderr, /pin: 4211` is still set/);

  // On the day of the close the unpin is a step of the close, not a fault, so
  // lint stays quiet and `aps doctor` does not call the register broken.
  const sameDay = `Mission: one line about the outcome\n\n${entry("P1", "First problem", { status: "done", thread: "topic:1", pin: "4211", learned: "one line", confirmed: `${DAY} done`, updated: DAY })}`;
  const fresh = overlay({ a: sameDay });
  const q = await aps(["lint", "--agent", "a"], { APS_OVERLAY: fresh });
  assert.doesNotMatch(q.stdout + q.stderr, /pin-stale|is still set/);
  // The report names it either way: that is the operator's surface for a pin
  // the agent could not take down.
  const rep = await aps(["report", "--agents", "a"], { APS_OVERLAY: fresh });
  assert.match(rep.stdout, /still pinned after the problem ended: P1 message 4211/);
});

test("the unpin names the command this deployment actually runs, not a bare aps", async () => {
  const dir = overlay({ a: PINNED });
  const r = await aps(["set", "P1", "status=done", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node \S*bin\/aps\.mjs set P1 pin= --overlay \S+ --agent a/);
});

test("replacing the pin with a new id during a close still names the message left up", async () => {
  const dir = overlay({ a: PINNED });
  const r = await aps(["set", "P1", "status=done", "pin=4299", "--agent", "a", "--confirmed"], { APS_OVERLAY: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /unpin: message 4211/);
});
