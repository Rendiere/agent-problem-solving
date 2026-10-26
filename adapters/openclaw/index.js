import { appendFile } from "node:fs/promises";
import { threadFromSessionKey, degradedNotice, selectForThread } from "../../lib/register.js";
import { checkDue, readChecks, markChecked } from "../../lib/closecheck.js";
import { readSession, gaugeLevel, today } from "../../lib/gauge.js";
import { buildInjection } from "../../lib/inject.js";
import { classifyTurn } from "../../lib/classify.js";
import {
  resolveOverlay,
  checkOverlay,
  agentIdError,
  registerPath,
  ledgerPath,
  snapshotPath,
  turnsPath,
  turnPath,
  checksPath,
  loadRegister,
  DEFAULT_REGISTER_FILE,
} from "../../lib/paths.js";
import { actorFromMarker, logHandEdits, recordTurn, readTurns, readTurnMarker, writeTurnMarker } from "../../lib/ledger.js";
import { apsCommand } from "../../lib/self.js";

// The hook's own budget. The gateway drops a hook that overruns its timeout,
// which would cost the agent its reminder, so the writing side waits briefly
// and gives up rather than queueing behind another writer.
const LOCK_WAIT_MS = 400;

async function trace(text, ctx, actor) {
  if (!process.env.APS_TRACE_FILE) return;
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      agentId: ctx?.agentId,
      sessionKey: ctx?.sessionKey,
      trigger: ctx?.trigger ?? null,
      channel: ctx?.channel ?? null,
      senderId: ctx?.senderId ?? null,
      actor,
    });
    await appendFile(process.env.APS_TRACE_FILE, `${line}\n${text}\n---\n`);
  } catch {
    // Tracing is for the spike and the tests; never lose the block over it.
  }
}

export default {
  id: "agent-problem-solving",
  name: "Agent Problem Solving",
  description: "Keeps each thread on one named problem: the register and a context gauge in front of the agent on every turn.",
  register(api) {
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const cfg = api.pluginConfig ?? {};
        if (cfg.enabled === false) return;
        if (Array.isArray(cfg.agents) && cfg.agents.length && !cfg.agents.includes(ctx?.agentId)) return;

        const registerFile = cfg.registerFile ?? DEFAULT_REGISTER_FILE;
        const reading = readSession(api, ctx?.agentId, ctx?.sessionKey);
        const { actor } = classifyTurn(ctx, event);
        const date = today(new Date(), cfg.timeZone);
        const common = {
          thread: threadFromSessionKey(ctx?.sessionKey),
          actor,
          reading,
          gauge: { warnTokens: cfg.warnTokens, highTokens: cfg.highTokens, canCompact: cfg.canCompact === true },
          registerFile,
          date,
        };

        const deliver = async (register, extra = {}) => {
          const text = buildInjection(register, { ...common, ...extra });
          await trace(text, ctx, actor);
          return { prependContext: text };
        };

        const { overlay, reason } = resolveOverlay(cfg, {});
        if (!overlay) return deliver(null, { notice: degradedNotice(reason) });
        const badAgent = agentIdError(ctx?.agentId);
        if (badAgent) return deliver(null, { notice: degradedNotice(badAgent) });
        const overlayProblem = await checkOverlay(overlay);
        if (overlayProblem) return deliver(null, { notice: degradedNotice(overlayProblem) });

        const agentId = ctx.agentId;
        const file = registerPath(overlay, agentId, registerFile);
        let { register, notice } = await loadRegister(file);
        let closeCheck = null;
        const command = apsCommand({ overlay, agentId, registerFile, thread: common.thread, sessionKey: ctx?.sessionKey });

        // An agent with no register has not been rolled out yet: tell it how to
        // start one, but write nothing into the overlay on its behalf.
        if (register) {
          try {
            const turnFile = turnPath(overlay, agentId, common.thread, ctx?.sessionKey);
            const marker = await readTurnMarker(turnFile);
            const logged = await logHandEdits({
              registerFile: file,
              snapshotFile: snapshotPath(overlay, agentId),
              ledgerFile: ledgerPath(overlay, agentId),
              agent: agentId,
              // Hand edits are found at the start of the next turn, so they
              // belong to the turn that was running when they were written.
              actor: actorFromMarker(marker),
              day: marker?.at ? today(new Date(marker.at), cfg.timeZone) : date,
              lastPersonTurn: (await readTurns(turnsPath(overlay, agentId))).lastPersonTurn ?? null,
              waitMs: LOCK_WAIT_MS,
            });
            // Something changed between this hook's own read and the lock, so
            // the block is built from the register as the lock saw it.
            if (Array.isArray(logged) && logged.length) {
              const fresh = await loadRegister(file);
              if (fresh.register) ({ register, notice } = fresh);
            }
            await writeTurnMarker(turnFile, { actor, sessionKey: ctx?.sessionKey });
            await recordTurn(turnsPath(overlay, agentId), { day: date, actor, level: gaugeLevel(reading, common.gauge), waitMs: LOCK_WAIT_MS });
          } catch {
            // A log or a counter that cannot be written must not cost the agent
            // its reminder.
          }
          try {
            // Once a day, ask the agent to check this thread's problem off.
            // Marked before the block goes out, so a reply the agent never acts
            // on costs one check rather than every turn of the day.
            const checksFile = checksPath(overlay, agentId);
            closeCheck = checkDue(selectForThread(register, common.thread), { date, checked: await readChecks(checksFile), actor });
            if (closeCheck) await markChecked(checksFile, closeCheck.id, date, { waitMs: LOCK_WAIT_MS });
          } catch {
            closeCheck = null;
          }
        }

        return deliver(register, { notice, registerPath: file, closeCheck, apsCommand: command });
      },
      { priority: 10, timeoutMs: 8000 },
    );
  },
};
