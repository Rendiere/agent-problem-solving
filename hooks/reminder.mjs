#!/usr/bin/env node
// The every-turn reminder on a command-line runtime.
//
// Claude Code and Codex both run a UserPromptSubmit hook, hand it one JSON
// object on stdin, and add `hookSpecificOutput.additionalContext` from stdout to
// the turn. So this one script serves both. OpenClaw calls a function instead,
// and has its own adapter.
//
// It must never cost the person a prompt. Every failure exits 0 with no output:
// a missing overlay, an unparseable event, a register nobody can read. A
// register that exists but cannot be read is the one case that does speak, as a
// one-line notice, because silence there would read as "no problem active".

import { buildInjection } from "../lib/inject.js";
import { degradedNotice } from "../lib/register.js";
import { today } from "../lib/gauge.js";
import {
  resolveOverlay, checkOverlay, registerPath, ledgerPath, snapshotPath,
  turnsPath, turnPath, loadRegister, DEFAULT_REGISTER_FILE,
} from "../lib/paths.js";
import { runtimeConfig } from "../lib/settings.js";
import { claimTurn } from "../lib/settings.js";
import { threadForCli, agentForCli, agentReason, inScope, actorForCli, ownedByAnotherAdapter } from "../adapters/cli/runtime.js";
import { apsCommand } from "../lib/self.js";
import {
  actorFromMarker, logHandEdits, recordTurn, readTurns, readTurnMarker,
  writeTurnMarker,
} from "../lib/ledger.js";

const LOCK_WAIT_MS = 400;

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(""));
  });
}

function emit(text) {
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
}

async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return; // Not an event this script understands. Say nothing.
  }
  if (!event || typeof event !== "object") return;

  // OpenClaw drives this same command line and injects its own block, so a turn
  // it started belongs to its adapter, not to this hook.
  if (ownedByAnotherAdapter()) return;

  const config = runtimeConfig();
  // A plugin-bundled hook and a hook installed in user settings may both see
  // the same prompt. One claim makes the second invocation silent.
  if (!claimTurn(event, process.env, config.overlayPath)) return;
  const { overlay, reason } = resolveOverlay({ overlayPath: config.overlayPath }, {});
  // A native marketplace install has the plugin but not its private problem
  // directory. Say exactly what remains instead of staying silently inert.
  if (!overlay) {
    const runtime = event.model ? "codex" : "claude-code";
    return emit(`Agent Problem Solving is installed but not set up. Run: npx github:Rendiere/agent-problem-solving install ${runtime}`);
  }
  // A hook in the person's own settings fires in every directory they open the
  // agent in. Only the ones they named get a reminder.
  if (!inScope(event.cwd, config.projects)) return;

  const thread = threadForCli(event.cwd);
  const date = today(new Date(), config.timeZone);
  // No runtime here reports a token total, so the gauge is absent, not guessed.
  const actor = actorForCli();
  const common = { thread, actor, date, includeGauge: false };

  const overlayProblem = await checkOverlay(overlay);
  if (overlayProblem) return emit(buildInjection(null, { ...common, notice: degradedNotice(overlayProblem) }));

  const agentId = agentForCli(overlay, config);
  if (!agentId) return emit(buildInjection(null, { ...common, notice: degradedNotice(agentReason(overlay, config)) }));

  const registerFile = config.registerFile ?? DEFAULT_REGISTER_FILE;
  const file = registerPath(overlay, agentId, registerFile);
  let { register, notice } = await loadRegister(file);
  let reading;
  if (register) {
    try {
      const markerFile = turnPath(overlay, agentId, thread, event.session_id ?? null);
      const marker = await readTurnMarker(markerFile);
      reading = { known: marker?.sessionKey === event.session_id };
      const logged = await logHandEdits({
        registerFile: file,
        snapshotFile: snapshotPath(overlay, agentId),
        ledgerFile: ledgerPath(overlay, agentId),
        agent: agentId,
        actor: actorFromMarker(marker),
        day: marker?.at ? today(new Date(marker.at), config.timeZone) : date,
        lastPersonTurn: (await readTurns(turnsPath(overlay, agentId))).lastPersonTurn ?? null,
        waitMs: LOCK_WAIT_MS,
      });
      if (Array.isArray(logged) && logged.length) {
        const fresh = await loadRegister(file);
        if (fresh.register) ({ register, notice } = fresh);
      }
      await writeTurnMarker(markerFile, { actor, sessionKey: event.session_id ?? null });
      await recordTurn(turnsPath(overlay, agentId), { day: date, actor, waitMs: LOCK_WAIT_MS });
    } catch {
      // Logging and counters are useful evidence, but never worth losing the reminder.
    }
  }
  emit(
    buildInjection(register, {
      ...common,
      reading,
      notice,
      registerFile,
      registerPath: file,
      apsCommand: apsCommand({ overlay, agentId, registerFile, thread, sessionKey: event.session_id ?? null }),
    }),
  );
}

try {
  await main();
} catch {
  // A broken install never blocks a prompt.
}
