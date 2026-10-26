import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../adapters/openclaw/index.js";
import { classifyTurn } from "../lib/classify.js";
import { readLedger } from "../lib/ledger.js";
import { today } from "../lib/gauge.js";
import { registerPath, agentIdError } from "../lib/paths.js";

const DAY = today();

function harness(pluginConfig = {}, entry = { totalTokens: 120_000 }) {
  let handler;
  plugin.register({
    pluginConfig,
    on: (name, fn) => {
      if (name === "before_prompt_build") handler = fn;
    },
    runtime: { agent: { session: { getSessionEntry: () => entry } } },
  });
  return handler;
}

function overlay(text) {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-hook-"));
  mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
  if (text !== null) writeFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), text);
  return dir;
}

const ACTIVE = `Mission: one line about the outcome\n\n## P1. Fix the thing\n- status: active\n- thread: topic:9\n- done when: the check passes\n- confirmed: ${DAY} active\n- updated: ${DAY}\n`;

// A turn from the person in a Telegram forum topic.
const personCtx = (dir) => ({
  agentId: "a",
  sessionKey: "agent:a:telegram:group:-100123:topic:9",
  trigger: "user",
  channel: "telegram",
  senderId: "42",
  workspaceDir: dir,
});

test("the hook puts this thread's problem and the gauge in front of a turn from the person", async () => {
  const dir = overlay(ACTIVE);
  const out = await harness({ overlayPath: dir })({ prompt: "what's next?", messages: [{ role: "user", content: "what's next?" }] }, personCtx(dir));
  assert.match(out.prependContext, /Thread topic:9: on P1 Fix the thing/);
  assert.match(out.prependContext, /Context: 120k tokens/);
  assert.match(out.prependContext, /Check: does this reply move/);
});

test("a heartbeat during an active problem gets the short block and no prompt (AE5)", async () => {
  const dir = overlay(ACTIVE);
  const out = await harness({ overlayPath: dir })({ prompt: "heartbeat" }, { ...personCtx(dir), trigger: "heartbeat", senderId: undefined });
  assert.match(out.prependContext, /on P1 Fix the thing/);
  assert.match(out.prependContext, /ask nothing and offer nothing/);
  assert.doesNotMatch(out.prependContext, /Check: does this reply move/);
  // Under about 120 tokens.
  assert.ok(out.prependContext.length < 480, `length ${out.prependContext.length}`);
});

test("a sub-agent completion report is automated, a button tap is not", async () => {
  const completion = {
    prompt: "[Inter-session message] sourceSession=agent:a:subagent:1 sourceTool=subagent_announce isUser=false\nDone.",
    messages: [{ role: "user", content: "Done.", provenance: { kind: "inter_session", sourceTool: "subagent_announce" } }],
  };
  assert.equal(classifyTurn({ trigger: "user", senderId: "42", channel: "telegram" }, completion).actor, "automated");
  // The same turn without the prompt prefix is still caught by the provenance.
  assert.equal(classifyTurn({ trigger: "user", senderId: "42" }, { prompt: "Done.", messages: completion.messages }).actor, "automated");
  // A number-button tap arrives as an ordinary channel message.
  assert.equal(classifyTurn({ trigger: "user", senderId: "42", channel: "telegram" }, { prompt: "1", messages: [{ role: "user", content: "1" }] }).actor, "person");
});

test("a turn with no trigger and no sender is automated", () => {
  assert.equal(classifyTurn({}, {}).actor, "automated");
  assert.equal(classifyTurn({ trigger: "cron" }, {}).actor, "automated");
  assert.equal(classifyTurn({ trigger: "memory" }, {}).actor, "automated");
  assert.equal(classifyTurn({ trigger: "user" }, {}).actor, "automated", "a user trigger with no sender is not evidence of a person");
  assert.equal(classifyTurn({ trigger: "user", channelContext: { sender: { id: "7" } } }, {}).actor, "person");
});

test("the hook skips other agents and a disabled plugin", async () => {
  const dir = overlay(ACTIVE);
  assert.equal(await harness({ overlayPath: dir, agents: ["other"] })({}, personCtx(dir)), undefined);
  assert.equal(await harness({ overlayPath: dir, enabled: false })({}, personCtx(dir)), undefined);
});

test("no overlayPath gives the degraded notice rather than a throw", async () => {
  const out = await harness({}, { totalTokens: 1000 })({}, { agentId: "a", sessionKey: "agent:a:x", trigger: "user", senderId: "42" });
  assert.match(out.prependContext, /Problem register unreadable: no overlayPath/);
  assert.match(out.prependContext, /Say so to the person in one line/);
});

test("a missing register names the file the agent should create", async () => {
  const dir = overlay(null);
  const out = await harness({ overlayPath: dir })({}, personCtx(dir));
  assert.match(out.prependContext, /No register at .*agents\/a\/PROBLEMS\.md/);
  assert.match(out.prependContext, /frame-problem skill/);
});

test("an unreadable register gives the degraded notice", async (t) => {
  // Root can read a 000 file, so the test would pass without proving anything.
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    t.skip("running as root: permission bits do not bite");
    return;
  }
  const dir = overlay(ACTIVE);
  const file = path.join(dir, "agents", "a", "PROBLEMS.md");
  chmodSync(file, 0o000);
  try {
    const out = await harness({ overlayPath: dir })({}, personCtx(dir));
    assert.match(out.prependContext, /Problem register unreadable:/);
    assert.match(out.prependContext, /Say so to the person in one line/);
  } finally {
    chmodSync(file, 0o600);
  }
});

test("the hook logs hand edits it finds and counts the turn", async () => {
  const dir = overlay(ACTIVE);
  const hook = harness({ overlayPath: dir });
  await hook({}, personCtx(dir));
  writeFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), ACTIVE.replace("status: active", "status: parked") + "- state: set aside\n");
  await hook({}, personCtx(dir));
  const rows = await readLedger(path.join(dir, "agents", "a", "decisions.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "parked");
  assert.equal(rows[0].source, "hand-edit");
  const { readTurns } = await import("../lib/ledger.js");
  const turns = await readTurns(path.join(dir, "agents", "a", "turns.json"));
  assert.equal(turns[DAY].person, 2);
});

test("the gauge levels come from the plugin config", async () => {
  const dir = overlay(ACTIVE);
  const out = await harness({ overlayPath: dir, warnTokens: 100_000, highTokens: 110_000 }, { totalTokens: 120_000 })({}, personCtx(dir));
  assert.match(out.prependContext, /Past 110k/);
});

test("an agent id that could walk out of the overlay is refused", () => {
  assert.match(agentIdError("../../etc"), /not a plain name/);
  assert.match(agentIdError("a/b"), /not a plain name/);
  assert.equal(agentIdError(undefined), "no agent id on this turn");
  assert.equal(agentIdError("assistant-2"), null);
  assert.throws(() => registerPath("/tmp/overlay", "../../etc"), /not a plain name/);
});

test("an overlay path that does not exist is reported, and nothing is created", async () => {
  const missing = path.join(tmpdir(), `aps-missing-${process.pid}-${Date.now()}`);
  const out = await harness({ overlayPath: missing })({}, { agentId: "a", sessionKey: "agent:a:x", trigger: "user", senderId: "42" });
  assert.match(out.prependContext, /Problem register unreadable: no overlay directory at/);
  assert.equal(existsSync(missing), false, "a typo in the path must not become a new overlay");
});

test("a relative overlay path is refused", async () => {
  const out = await harness({ overlayPath: "overlay" })({}, { agentId: "a", sessionKey: "agent:a:x", trigger: "user", senderId: "42" });
  assert.match(out.prependContext, /is not an absolute path/);
});

test("an agent with no register gets the nudge and no files are written for it", async () => {
  const dir = overlay(null);
  const out = await harness({ overlayPath: dir })({}, personCtx(dir));
  assert.match(out.prependContext, /No register at/);
  assert.deepEqual(readdirSync(path.join(dir, "agents", "a")), [], "no turn counts or snapshot for an agent that has not been rolled out");
  assert.equal(existsSync(path.join(dir, "state")), false);
});

test("the gauge separates an unknown reading from a session's first turn", async () => {
  const dir = overlay(ACTIVE);
  const fresh = await harness({ overlayPath: dir }, null)({}, personCtx(dir));
  assert.match(fresh.prependContext, /Context: unknown\./);
  assert.match(fresh.prependContext, /First turn of this session: open your reply with "Back on: P1/);
  const unknown = await harness({ overlayPath: dir }, { totalTokens: 0 })({}, personCtx(dir));
  assert.match(unknown.prependContext, /Context: unknown\./);
  assert.doesNotMatch(unknown.prependContext, /First turn of this session/);
});

// The block names a command the agent is told to run, so the test runs it. An
// assertion on its shape alone once accepted a path that did not exist and an
// argument order the command refused.
test("the command the block gives the agent actually changes the register", async () => {
  const dir = overlay(ACTIVE);
  const out = await harness({ overlayPath: dir })({}, personCtx(dir));
  const printed = out.prependContext.split("\n").find((l) => l.startsWith("Change it: "))?.slice("Change it: ".length);
  assert.ok(printed, out.prependContext);
  assert.ok(printed.includes(dir), printed);
  const r = spawnSync("sh", ["-c", printed.replace("set <ID> field=value", "set P1 status=parked state=waiting")], { encoding: "utf8" });
  assert.equal(r.status, 0, `${printed}\n${r.stdout}\n${r.stderr}`);
  assert.match(readFileSync(registerPath(dir, "a"), "utf8"), /status: parked/);
});

test("a hand edit made during an automated turn is attributed to that turn", async () => {
  const dir = overlay(ACTIVE);
  const hook = harness({ overlayPath: dir });
  // A heartbeat runs, and the agent edits the register during it.
  await hook({ prompt: "heartbeat" }, { ...personCtx(dir), trigger: "heartbeat", senderId: undefined });
  writeFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), ACTIVE.replace("status: active", "status: done"));
  // The person's next turn is when the hook notices.
  await hook({}, personCtx(dir));
  const rows = await readLedger(path.join(dir, "agents", "a", "decisions.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "closed");
  assert.equal(rows[0].actor, "automated");
  assert.match(rows[0].flag, /automated turn/);
});

// The check runs the same way on OpenClaw: raised on the first turn of the day
// in that topic, and not again until tomorrow.
const OPEN_A_WHILE = ACTIVE.replace(`- confirmed: ${DAY} active`, "- confirmed: 2026-01-01 active");

test("the first turn of the day in a topic carries the close-check, and the next does not", async () => {
  const dir = overlay(OPEN_A_WHILE);
  const hook = harness({ overlayPath: dir });
  const turn = () => hook({ prompt: "what's next?", messages: [{ role: "user", content: "what's next?" }] }, personCtx(dir));
  assert.match((await turn()).prependContext, /Close-check on P1/);
  assert.doesNotMatch((await turn()).prependContext, /Close-check/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "state", "a.checks.json"), "utf8")), { P1: DAY });
});

test("a heartbeat is never asked to check a problem off", async () => {
  const dir = overlay(OPEN_A_WHILE);
  const out = await harness({ overlayPath: dir })({ prompt: "heartbeat" }, { ...personCtx(dir), trigger: "heartbeat", senderId: undefined });
  assert.doesNotMatch(out.prependContext, /Close-check/);
  assert.ok(!existsSync(path.join(dir, "state", "a.checks.json")), "an automated turn marks nothing");
});
