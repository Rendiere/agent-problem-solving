import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRegister } from "../lib/register.js";
import { snapshotOf, diffSnapshots, logHandEdits, readLedger, recordTurn, readTurns, flagFor, BUSY } from "../lib/ledger.js";
import { today } from "../lib/gauge.js";

const DAY = today();

function overlay() {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-ledger-"));
  mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
  mkdirSync(path.join(dir, "state"), { recursive: true });
  return dir;
}

const files = (dir) => ({
  registerFile: path.join(dir, "agents", "a", "PROBLEMS.md"),
  snapshotFile: path.join(dir, "state", "a.snapshot.json"),
  ledgerFile: path.join(dir, "agents", "a", "decisions.jsonl"),
});

function entry(id, fields) {
  return `## ${id}. Title for ${id}\n${Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`;
}

// The hook re-reads the register inside its lock, so a run means: write the
// register, then let the diff find what changed.
async function run(dir, text, opts = {}) {
  const f = files(dir);
  writeFileSync(f.registerFile, text);
  return logHandEdits({ ...f, agent: "a", actor: "person", day: DAY, ...opts });
}

test("the first run records the register and logs nothing", async () => {
  const dir = overlay();
  const text = `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`;
  assert.deepEqual(await run(dir, text), []);
  assert.deepEqual(await readLedger(files(dir).ledgerFile), []);
});

test("proposed to active with a same-day confirmed line is logged and not flagged", async () => {
  const dir = overlay();
  await run(dir, `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`);
  const rows = await run(dir, `Mission: m\n\n${entry("P1", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` })}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "opened");
  assert.equal(rows[0].source, "hand-edit");
  assert.equal(rows[0].flag, null);
});

test("the same move with no confirmed line is logged and flagged", async () => {
  const dir = overlay();
  await run(dir, `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`);
  const rows = await run(dir, `Mission: m\n\n${entry("P1", { status: "active", thread: "topic:1", "done when": "x" })}`);
  assert.match(rows[0].flag, /no confirmed: line/);
});

test("a confirmed line written during an automated turn is flagged", async () => {
  const dir = overlay();
  await run(dir, `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`);
  const rows = await run(dir, `Mission: m\n\n${entry("P1", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` })}`, { actor: "automated" });
  assert.match(rows[0].flag, /automated turn/);
});

test("no turn from the operator on the day the change landed is flagged", () => {
  const e = { kind: "opened", to: "active", confirmed: DAY };
  assert.equal(flagFor(e, { actor: "person", day: DAY, lastPersonTurn: DAY }), null);
  assert.match(flagFor(e, { actor: "person", day: DAY, lastPersonTurn: "2026-01-01" }), /no turn from the operator/);
});

test("a drift question that clears while the problem is parked logs the notice and the park", async () => {
  const dir = overlay();
  const active = { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` };
  await run(dir, `Mission: m\n\n${entry("P1", active)}`);
  const raised = await run(dir, `Mission: m\n\n${entry("P1", { ...active, pending: `drift ${DAY}` })}`);
  assert.deepEqual(raised.map((r) => r.kind), ["drift notice"]);
  const answered = await run(dir, `Mission: m\n\n${entry("P1", { status: "parked", thread: "topic:1", "done when": "x", state: "set aside" })}`);
  const notice = answered.find((r) => r.kind === "drift notice answered");
  assert.equal(notice.outcome, "park");
  assert.ok(answered.some((r) => r.kind === "parked"));
});

test("a cleared reset offer logs the reset", async () => {
  const dir = overlay();
  const active = { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` };
  await run(dir, `Mission: m\n\n${entry("P1", { ...active, pending: `reset ${DAY}` })}`);
  const rows = await run(dir, `Mission: m\n\n${entry("P1", active)}`);
  assert.equal(rows[0].kind, "reset offer answered");
  assert.equal(rows[0].outcome, "reset");
});

test("closing a side task logs the close and the parent's resume", async () => {
  const dir = overlay();
  const parent = { status: "paused", thread: "topic:1", "done when": "p" };
  const child = { status: "active", thread: "topic:1", parent: "P1", "done when": "c", confirmed: `${DAY} active` };
  await run(dir, `Mission: m\n\n${entry("P1", parent)}\n${entry("P2", child)}`);
  const rows = await run(
    dir,
    `Mission: m\n\n${entry("P1", { ...parent, status: "active", confirmed: `${DAY} active` })}\n${entry("P2", { ...child, status: "done", confirmed: `${DAY} done`, learned: "one line" })}`,
  );
  const kinds = rows.map((r) => `${r.problem}:${r.kind}`);
  assert.ok(kinds.includes("P2:closed"), kinds.join(","));
  assert.ok(kinds.includes("P1:switched"), kinds.join(","));
});

test("earlier log lines are byte-identical after a hundred runs that keep appending", async () => {
  const dir = overlay();
  const { ledgerFile } = files(dir);
  const active = { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` };
  const parked = { status: "parked", thread: "topic:1", "done when": "x", state: "set aside" };
  await run(dir, `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`);
  await run(dir, `Mission: m\n\n${entry("P1", active)}`);
  const first = readFileSync(ledgerFile, "utf8");
  assert.ok(first.length, "the opening transition is on disk");

  // Half the runs change nothing; the rest park and unpark, so the file keeps
  // growing while the first lines have to stay exactly as they were.
  for (let i = 0; i < 100; i += 1) {
    await run(dir, `Mission: m\n\n${entry("P1", i % 4 === 1 ? parked : i % 4 === 3 ? active : i % 2 ? parked : active)}`);
  }
  const after = readFileSync(ledgerFile, "utf8");
  assert.ok(after.startsWith(first), "the earlier lines were rewritten");
  assert.ok(after.length > first.length, "the later runs appended nothing");
  const rows = await readLedger(ledgerFile);
  assert.ok(rows.every((r) => r.kind !== "unreadable log line"), "every appended line is valid JSON");
  assert.ok(rows.length > 10, `only ${rows.length} lines`);
});

test("two hook runs at once log each hand edit exactly once", async () => {
  const dir = overlay();
  await run(dir, `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`);
  const text = `Mission: m\n\n${entry("P1", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` })}`;
  await Promise.all([run(dir, text), run(dir, text)]);
  const rows = await readLedger(files(dir).ledgerFile);
  assert.equal(rows.filter((r) => r.kind === "opened").length, 1);
});

test("turn counts land per day, with the share above the warning level", async () => {
  const dir = overlay();
  const file = path.join(dir, "agents", "a", "turns.json");
  await recordTurn(file, { day: DAY, actor: "person", level: "ok" });
  await recordTurn(file, { day: DAY, actor: "person", level: "warn" });
  await Promise.all([recordTurn(file, { day: DAY, actor: "automated", level: "high" }), recordTurn(file, { day: DAY, actor: "person", level: "ok" })]);
  const turns = await readTurns(file);
  assert.equal(turns[DAY].person, 3);
  assert.equal(turns[DAY].automated, 1);
  // The share above the warning level is about the operator's turns, so the
  // automated one at the high level is not counted (R39).
  assert.equal(turns[DAY].aboveWarn, 1);
  assert.equal(turns.lastPersonTurn, DAY);
});

test("a removed entry is logged, not silently dropped", () => {
  const before = snapshotOf(parseRegister(`Mission: m\n\n${entry("P1", { status: "active", thread: "topic:1" })}`));
  const rows = diffSnapshots(before, { problems: {} });
  assert.equal(rows[0].kind, "removed from the register");
});

test("an unreadable log line is reported rather than thrown", async () => {
  const dir = overlay();
  const { ledgerFile } = files(dir);
  writeFileSync(ledgerFile, "{not json}\n");
  const rows = await readLedger(ledgerFile);
  assert.equal(rows[0].kind, "unreadable log line");
});

test("a damaged turns file is kept, not overwritten", async () => {
  const dir = overlay();
  const file = path.join(dir, "agents", "a", "turns.json");
  await recordTurn(file, { day: "2026-10-01", actor: "person" });
  writeFileSync(file, "{ truncated");
  await recordTurn(file, { day: DAY, actor: "person" });
  const turns = await readTurns(file);
  assert.equal(turns[DAY].person, 1);
  const kept = readdirSync(path.join(dir, "agents", "a")).filter((n) => n.includes("corrupt"));
  assert.equal(kept.length, 1, "the unreadable file is set aside, so nothing is silently lost");
});

test("a question replaced by another logs the answer and then the new question", () => {
  const was = { problems: { P1: { title: "a", status: "active", thread: "topic:1", pending: "switch 2026-10-13", confirmed: null } } };
  const now = { problems: { P1: { title: "a", status: "active", thread: "topic:1", pending: "drift 2026-10-14", confirmed: null } } };
  const kinds = diffSnapshots(was, now).map((e) => `${e.kind}:${e.outcome ?? ""}`);
  assert.deepEqual(kinds, ["switch question answered:stay", "drift notice:"]);
});

test("a busy lock is reported rather than waited on forever", async () => {
  const dir = overlay();
  const f = files(dir);
  writeFileSync(f.registerFile, `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`);
  mkdirSync(`${f.snapshotFile}.lock`, { recursive: true });
  try {
    const started = Date.now();
    const out = await logHandEdits({ ...f, agent: "a", actor: "person", waitMs: 50 });
    assert.equal(out, BUSY);
    assert.ok(Date.now() - started < 1000);
  } finally {
    rmSync(`${f.snapshotFile}.lock`, { recursive: true, force: true });
  }
});

test("the register is read inside the lock, so a change that lands while waiting is logged once and forwards", async () => {
  const dir = overlay();
  const f = files(dir);
  const proposed = `Mission: m\n\n${entry("P1", { status: "proposed", thread: "topic:1" })}`;
  const active = `Mission: m\n\n${entry("P1", { status: "active", thread: "topic:1", "done when": "x", confirmed: `${DAY} active` })}`;
  await run(dir, proposed);

  // The hook is called while the register still says "proposed" and the lock is
  // held by someone else. By the time it gets in, the entry is active. A diff
  // built from the call-time read would log "opened" and then, next turn,
  // "reworded" and "opened" again — a reverse transition that never happened.
  mkdirSync(`${f.snapshotFile}.lock`, { recursive: true });
  const waiting = logHandEdits({ ...f, agent: "a", actor: "person", day: DAY, waitMs: 3_000 });
  await new Promise((r) => setTimeout(r, 60));
  writeFileSync(f.registerFile, active);
  rmSync(`${f.snapshotFile}.lock`, { recursive: true, force: true });
  const rows = await waiting;

  assert.deepEqual(rows.map((r) => `${r.kind}:${r.from}->${r.to}`), ["opened:proposed->active"]);
  // The next run sees nothing left over: the snapshot moved with the read.
  assert.deepEqual(await run(dir, active), []);
  assert.equal((await readLedger(f.ledgerFile)).length, 1);
});
