// One OpenClaw plugin: put the problem register in front of the agent on every
// turn, and write every change it finds to an append-only decision log.
//
// Nothing here is specific to one operator. Everything the plugin reads about
// missions, problems, threads and agents comes from the overlay directory named
// in `overlayPath`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { threadFromSessionKey } from "./lib/register.js";
import { readRegister, overlayRoot } from "./lib/store.js";
import { readSessionTokens, gaugeBand } from "./lib/gauge.js";
import { buildInjection, buildShortInjection } from "./lib/inject.js";
import { classifyTurn, PERSON } from "./lib/classify.js";
import {
  appendLog, diffRegister, readSnapshot, readTurnMarker, recordTurn, snapshotOf, withLock, writeSnapshot, writeTurnMarker,
} from "./lib/ledger.js";
import { logPath } from "./lib/store.js";

const HOOK_LOCK_WAIT_MS = 600;
const APS_BIN = fileURLToPath(new URL("./bin/aps.mjs", import.meta.url));

function stateDirOf(cfg) {
  if (cfg.stateDir) return path.resolve(cfg.stateDir);
  const root = overlayRoot(cfg);
  return root ? path.join(root, ".state") : "";
}

function gaugeOpts(cfg) {
  return {
    warnTokens: cfg.warnTokens,
    highTokens: cfg.highTokens,
    compactShrinksSession: cfg.compactShrinksSession === true,
    resetCommand: cfg.resetCommand,
  };
}

/** Remember each session's size so the report can name the largest one (R20). */
async function noteSession(stateDir, agentId, sessionKey, reading) {
  if (!stateDir || !sessionKey || !reading) return;
  const file = path.join(stateDir, `${agentId}.sessions.json`);
  let data = {};
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    data = {};
  }
  data[sessionKey] = { tokens: reading.tokens, at: new Date().toISOString() };
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const [k, v] of Object.entries(data)) {
    if (Date.parse(v?.at ?? "") < cutoff) delete data[k];
  }
  await mkdir(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, file);
}

/**
 * Catch up the decision log with anything edited outside `aps set`. The lock
 * makes each transition log once even when two turns overlap; a turn that
 * cannot take the lock leaves the snapshot where it is, so the next turn finds
 * the same change and logs it then (KTD6).
 */
async function catchUpLog(cfg, agentId, stateDir, actor) {
  const file = logPath(cfg, agentId);
  if (!file || !stateDir) return [];
  return withLock(
    stateDir,
    agentId,
    async () => {
      const current = await readRegister(cfg, agentId);
      if (!current.ok) return [];
      const snapshot = await readSnapshot(stateDir, agentId);
      const entries = diffRegister(snapshot, current.register, { actor });
      if (entries.length) await appendLog(file, entries, { agent: agentId, source: "hand-edit", actor });
      await writeSnapshot(stateDir, agentId, snapshotOf(current.register));
      return entries;
    },
    { waitMs: HOOK_LOCK_WAIT_MS },
  ).catch(() => []);
}

export default {
  id: "agent-problem-solving",
  name: "Agent Problem Solving",
  description: "One named problem per thread, re-injected every turn, with an append-only decision log.",
  register(api) {
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const cfg = api.pluginConfig ?? {};
        if (cfg.enabled === false) return;
        const agentId = ctx?.agentId;
        if (Array.isArray(cfg.agents) && cfg.agents.length && !cfg.agents.includes(agentId)) return;

        const turn = classifyTurn(event, ctx);
        const thread = threadFromSessionKey(ctx?.sessionKey);
        const reading = readSessionTokens(api, agentId, ctx?.sessionKey);
        const gauge = gaugeOpts(cfg);
        const stateDir = stateDirOf(cfg);

        let source;
        try {
          source = await readRegister(cfg, agentId);
        } catch (err) {
          source = { ok: false, degraded: `${err?.code ?? "error"}: ${err?.message ?? err}` };
        }

        const build = turn.kind === PERSON ? buildInjection : buildShortInjection;
        const root = overlayRoot(cfg);
        const command = source.ok && root
          ? `Register: ${source.file}. Run: node ${APS_BIN} --overlay ${root} --agent ${agentId}`
          : "";
        const text = build(source, { thread, reading, gauge, automated: turn.kind !== PERSON, command });

        // Bookkeeping after the text is composed, so a slow write never costs
        // the agent its reminder.
        if (source.ok && stateDir) {
          const previous = await readTurnMarker(stateDir, agentId);
          await catchUpLog(cfg, agentId, stateDir, previous?.actor ?? "person");
          await writeTurnMarker(stateDir, agentId, { actor: turn.kind, sessionKey: ctx?.sessionKey }).catch(() => {});
          await Promise.all([
            recordTurn(stateDir, agentId, { band: gaugeBand(reading, gauge), person: turn.kind === PERSON }).catch(() => {}),
            noteSession(stateDir, agentId, ctx?.sessionKey, reading).catch(() => {}),
          ]);
        }

        if (process.env.APS_TRACE_FILE) {
          const { appendFile } = await import("node:fs/promises");
          await appendFile(
            process.env.APS_TRACE_FILE,
            `${new Date().toISOString()} ${agentId} ${ctx?.sessionKey} ${turn.kind} (${turn.why})\n${text}\n---\n`,
          ).catch(() => {});
        }
        return { prependContext: text };
      },
      { priority: 10, timeoutMs: 2000 },
    );
  },
};
