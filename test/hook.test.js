import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../index.js";
import { readLog } from "../lib/ledger.js";
import { overlay, reg, P } from "./helpers.js";

function harness(pluginConfig, entry = { totalTokens: 120_000 }) {
  let handler;
  plugin.register({
    pluginConfig,
    on: (name, fn) => { if (name === "before_prompt_build") handler = fn; },
    runtime: { agent: { session: { getSessionEntry: () => entry } } },
  });
  return handler;
}

const personCtx = (over = {}) => ({
  agentId: "a",
  sessionKey: "agent:a:telegram:group:-1:topic:9",
  runId: "6cac05bb-423c-4221-a8fa-62db8bb83c18",
  trigger: "user",
  ...over,
});
const personEvent = { prompt: "do the thing" };

const ACTIVE = reg(P("P1", { title: "Fix it", status: "active", thread: "topic:9", done_when: "it works", updated: "2026-10-14" }));

test("the hook prepends this thread's problem and the gauge", async () => {
  const root = overlay({ a: ACTIVE });
  const out = await harness({ overlayPath: root })(personEvent, personCtx());
  assert.match(out.prependContext, /on P1 Fix it/);
  assert.match(out.prependContext, /Context: 120k tokens/);
  assert.match(out.prependContext, /Check before you reply/);
});

test("the hook runs only for the agents it is configured for", async () => {
  const root = overlay({ a: ACTIVE });
  const h = harness({ overlayPath: root, agents: ["beta"] });
  assert.equal(await h(personEvent, personCtx({ agentId: "a" })), undefined);
  assert.ok((await h(personEvent, personCtx({ agentId: "beta" }))).prependContext);
});

test("enabled:false turns the hook off", async () => {
  const root = overlay({ a: ACTIVE });
  assert.equal(await harness({ overlayPath: root, enabled: false })(personEvent, personCtx()), undefined);
});

test("an automated turn still carries the reminder, and asks nothing", async () => {
  const root = overlay({ a: ACTIVE });
  const h = harness({ overlayPath: root });
  for (const ctx of [
    personCtx({ trigger: "heartbeat" }),
    personCtx({ trigger: "cron", sessionKey: "agent:a:cron:x:run:y" }),
    personCtx({ sessionKey: "agent:a:subagent:1" }),
  ]) {
    const out = await h(personEvent, ctx);
    assert.ok(out?.prependContext, `no block for ${ctx.trigger}/${ctx.sessionKey}`);
    assert.match(out.prependContext, /ask them nothing/);
    assert.doesNotMatch(out.prependContext, /Check before you reply/);
  }
});

test("a sub-agent completion report in the parent thread gets the short block", async () => {
  const root = overlay({ a: ACTIVE });
  const out = await harness({ overlayPath: root })(
    { prompt: "[Inter-session message] sourceTool=subagent_announce isUser=false\nChild result" },
    personCtx({ runId: "announce:v1:agent:a:subagent:9cbc:a6b" }),
  );
  assert.match(out.prependContext, /ask them nothing/);
  assert.doesNotMatch(out.prependContext, /Check before you reply/);
});

test("a missing register gives the degraded notice, not 'no problem'", async () => {
  const root = overlay({});
  const out = await harness({ overlayPath: root })(personEvent, personCtx());
  assert.match(out.prependContext, /Problem register unreadable/);
  assert.doesNotMatch(out.prependContext, /no problem\./);
});

test("no overlayPath gives the degraded notice and does not throw", async () => {
  const out = await harness({})(personEvent, personCtx());
  assert.match(out.prependContext, /Problem register unreadable: no overlayPath/);
});

test("the hook logs a hand edit once, and only once", async () => {
  const root = overlay({ a: ACTIVE });
  const h = harness({ overlayPath: root });
  const log = path.join(root, "agents", "a", "decisions.jsonl");
  await h(personEvent, personCtx());
  const first = await readLog(log);
  assert.ok(first.some((e) => e.kind === "opened" && e.problem === "P1"));
  await h(personEvent, personCtx());
  assert.deepEqual(await readLog(log), first, "a second turn logged the same change again");
});

test("two concurrent hook runs log each hand-edited transition once", async () => {
  const root = overlay({ a: ACTIVE });
  const h = harness({ overlayPath: root });
  const log = path.join(root, "agents", "a", "decisions.jsonl");
  await Promise.all([h(personEvent, personCtx()), h(personEvent, personCtx({ runId: "7cac05bb-423c-4221-a8fa-62db8bb83c18" }))]);
  const lines = (await readLog(log)).filter((e) => e.kind === "opened" && e.problem === "P1");
  assert.equal(lines.length, 1, JSON.stringify(await readLog(log), null, 1));
});

test("the log's earlier lines are byte-identical after a hundred hook runs", async () => {
  const root = overlay({ a: ACTIVE });
  const h = harness({ overlayPath: root });
  const log = path.join(root, "agents", "a", "decisions.jsonl");
  await h(personEvent, personCtx());
  const head = readFileSync(log, "utf8");
  for (let i = 0; i < 100; i += 1) await h(personEvent, personCtx());
  assert.equal(readFileSync(log, "utf8").slice(0, head.length), head);
});

test("turn counts record how many turns sat above the warning level (R39)", async () => {
  const root = overlay({ a: ACTIVE });
  const cfg = { overlayPath: root, warnTokens: 100_000, highTokens: 200_000 };
  await harness(cfg, { totalTokens: 50_000 })(personEvent, personCtx());
  await harness(cfg, { totalTokens: 150_000 })(personEvent, personCtx());
  await harness(cfg, { totalTokens: 250_000 })(personEvent, personCtx({ trigger: "cron", sessionKey: "agent:a:cron:x:run:y" }));
  const day = new Date().toISOString().slice(0, 10);
  const counts = JSON.parse(readFileSync(path.join(root, ".state", "a.turns.json"), "utf8"));
  assert.deepEqual(counts[day], { turns: 3, person: 2, warn: 1, high: 0 });
});

test("the hook never throws, whatever the register holds", async () => {
  const root = overlay({ a: "not a register at all\n## not-a-problem\n- : \n" });
  const out = await harness({ overlayPath: root })(personEvent, personCtx());
  assert.ok(typeof out.prependContext === "string" && out.prependContext.length > 0);
});
