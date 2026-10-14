import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, isPersonTurn } from "../lib/classify.js";

// Every context below is a field-for-field copy of one recorded in
// docs/spike-turns.md.
const PERSON_TURN = [
  { prompt: "[Wed 2026-10-14 09:13 GMT+1] do the thing" },
  { trigger: "user", sessionKey: "agent:spike:telegram:group:-1009:topic:777", runId: "6cac05bb-423c-4221-a8fa-62db8bb83c18", channel: "webchat" },
];
const CRON = [
  { prompt: "[cron:d8cd95db apsprobe] Say CRON." },
  { trigger: "cron", sessionKey: "agent:spike:cron:d8cd95db:run:b66055f9", runId: "b66055f9-9b69-422c-b793-659e4b848d44" },
];
const SUBAGENT_RUN = [
  { prompt: "[Wed 2026-10-14 09:13 GMT+1] [Subagent Context] You are running as a subagent (depth 1/1)." },
  { trigger: "user", sessionKey: "agent:spike:subagent:9cbc8082", runId: "a6b35f36-8cd8-4a90-9e38-a3e15f40cf4c" },
];
const COMPLETION_REPORT = [
  { prompt: "[Inter-session message] sourceSession=agent:spike:subagent:9cbc8082 sourceChannel=webchat sourceTool=subagent_announce isUser=false\nThis content was routed by OpenClaw…" },
  { trigger: "user", sessionKey: "agent:spike:telegram:group:-1009:topic:777", runId: "announce:v1:agent:spike:subagent:9cbc8082:a6b35f36" },
];

test("a person's message is the person's turn", () => {
  assert.equal(classifyTurn(...PERSON_TURN).kind, "person");
  assert.ok(isPersonTurn(...PERSON_TURN));
});

test("a cron run is automated", () => {
  assert.equal(classifyTurn(...CRON).kind, "automated");
});

test("a sub-agent's own run is automated", () => {
  assert.equal(classifyTurn(...SUBAGENT_RUN).kind, "automated");
});

test("a sub-agent completion report landing in the parent is automated", () => {
  const r = classifyTurn(...COMPLETION_REPORT);
  assert.equal(r.kind, "automated");
  assert.match(r.why, /isUser=false/);
});

test("the completion report differs from the person's turn only in runId and prompt", () => {
  const [, person] = PERSON_TURN;
  const [, report] = COMPLETION_REPORT;
  assert.equal(person.trigger, report.trigger);
  assert.equal(person.sessionKey, report.sessionKey);
  // So the classifier must not be reading trigger or sessionKey alone here.
  assert.equal(classifyTurn({ prompt: "x" }, report).kind, "automated", "the run id alone must still catch it");
  assert.equal(classifyTurn(COMPLETION_REPORT[0], { ...report, runId: "plain-uuid" }).kind, "automated", "the prompt alone must still catch it");
});

test("a heartbeat is automated", () => {
  assert.equal(classifyTurn({ prompt: "poll" }, { trigger: "heartbeat", sessionKey: "agent:a:telegram:group:-1:topic:7", runId: "u" }).kind, "automated");
});

test("a turn with no trigger and no sender is automated", () => {
  assert.equal(classifyTurn({}, {}).kind, "automated");
  assert.equal(classifyTurn({ prompt: "hi" }, { sessionKey: "agent:a:x" }).kind, "automated");
});

test("an unknown trigger is automated, so a value the spike never saw cannot pass as a person", () => {
  assert.equal(classifyTurn({ prompt: "x" }, { trigger: "followup", sessionKey: "agent:a:telegram:group:-1:topic:7", runId: "u" }).kind, "automated");
});

test("a relayed message the runtime marks as the person's stays the person's", () => {
  const r = classifyTurn(
    { prompt: "[Inter-session message] sourceSession=agent:main:telegram sourceTool=sessions_send isUser=true\nwhere were we?" },
    { trigger: "user", sessionKey: "agent:a:telegram:group:-1:topic:7", runId: "u" },
  );
  assert.equal(r.kind, "person");
});

test("an inter-session turn that states no origin is automated", () => {
  assert.equal(
    classifyTurn({ prompt: "[Inter-session message] sourceSession=x\nbody" }, { trigger: "user", sessionKey: "agent:a:t", runId: "u" }).kind,
    "automated",
  );
});

test("an inline button tap reaches the agent as an ordinary inbound message", () => {
  // Phase B sends the choices as buttons; a tap arrives with a real sender and
  // no inter-session envelope, so it classifies as the person's turn.
  const r = classifyTurn(
    { prompt: "callback_data: 1" },
    { trigger: "user", sessionKey: "agent:a:telegram:group:-1:topic:7", runId: "c0ffee00-0000-4000-8000-000000000000", senderId: "4455", channel: "telegram" },
  );
  assert.equal(r.kind, "person");
});
