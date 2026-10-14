// What a command-line runtime can tell the reminder, and what it cannot.
//
// Claude Code and Codex both run a prompt-submit hook and hand it the session
// id, the working directory and the prompt. Neither reports how full the
// session is, so the gauge is left out rather than guessed. Every turn a hook
// sees is a turn the person typed, so there is nothing to classify.

import { readdirSync, existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentIdError } from "../../lib/paths.js";

/**
 * The thread a command-line session belongs to.
 *
 * The session id changes every time the person starts the agent, so it cannot
 * carry a problem. The project does: the same project tomorrow is the same
 * thread, which is what a register entry needs.
 *
 * It is the project root written out in full, not its last segment. Two
 * unrelated checkouts both called "api" would otherwise share one problem, and
 * each would refuse to activate the other's. Under the home directory it is
 * written with a tilde so a person can read it and a register can move machines.
 */
export function threadForCli(cwd, env = process.env) {
  const dir = String(cwd ?? "").trim();
  if (!dir) return null;
  let real;
  try {
    real = realpathSync(path.resolve(dir));
  } catch {
    real = path.resolve(dir);
  }
  const root = gitRoot(real) ?? real;
  const home = env.HOME ? path.resolve(env.HOME) : os.homedir();
  const shown = home && (root === home || root.startsWith(`${home}${path.sep}`))
    ? `~${root.slice(home.length)}`
    : root;
  return `dir:${shown}`;
}

/**
 * The top of the checkout the directory sits in. Starting the agent in a
 * subfolder is the same thread as starting it at the top; a worktree is its own
 * project, because its `.git` is a file beside its own root.
 */
function gitRoot(dir) {
  let at = dir;
  for (;;) {
    if (existsSync(path.join(at, ".git"))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * Whether this directory is one the person pointed the reminder at.
 *
 * An empty list means every directory, which is what an install with no project
 * named does. A list means only those, which is the only way to keep the
 * reminder out of an employer's checkout, another agent's workspace, or any
 * other repository that shares a machine with it.
 */
export function inScope(cwd, projects = []) {
  if (!Array.isArray(projects) || !projects.length) return true;
  const dir = path.resolve(String(cwd ?? ""));
  return projects.some((raw) => {
    const p = path.resolve(String(raw ?? "").replace(/^~(?=$|\/)/, process.env.HOME ?? os.homedir()));
    return dir === p || dir.startsWith(`${p}${path.sep}`);
  });
}

/**
 * Who this turn came from. The default is the person, because an interactive
 * session is what a prompt-submit hook is for, but a scripted run is not a
 * person: prompting one asks a question nobody will read, and recording a
 * confirmation from one is a confirmation nobody gave.
 */
export function actorForCli(env = process.env) {
  if (env.CLAUDE_CODE_SESSION_ATTENDED === "0") return "automated";
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT ?? "").toLowerCase();
  const scripted = new Set(["sdk-cli", "sdk-ts", "sdk-py", "mcp", "claude-code-github-action", "local-agent"]);
  if (scripted.has(entry)) return "automated";
  return "person";
}

/**
 * Whether another adapter already owns this turn. OpenClaw runs the agent
 * through this same command line and injects its own block, so a hook installed
 * for the person's own sessions must stay out of the gateway's: two blocks on
 * one turn, one of them with the wrong thread, is worse than one.
 */
export function ownedByAnotherAdapter(env = process.env) {
  return Boolean(env.OPENCLAW_MCP_SESSION_KEY || env.OPENCLAW_MCP_AGENT_ID || env.OPENCLAW_CLI);
}

export function agentsIn(overlay) {
  try {
    return readdirSync(path.join(overlay, "agents"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Which agent's register this runtime reads. A command line has no agent id of
 * its own, so it is named in the settings, or inferred when the overlay holds
 * exactly one agent. Two agents and no name is reported, never guessed.
 *
 * @returns {string|null} the agent id, or null with the reason on `.reason`
 */
export function agentForCli(overlay, config = {}) {
  const named = String(config.agentId ?? "").trim();
  if (named) return agentIdError(named) ? null : named;
  const all = agentsIn(overlay);
  if (all.length === 1) return all[0];
  return null;
}

export function agentReason(overlay, config = {}) {
  const named = String(config.agentId ?? "").trim();
  if (named) return agentIdError(named);
  const all = agentsIn(overlay);
  if (all.length === 1) return null;
  if (!all.length) return `no agents in ${path.join(overlay, "agents")}`;
  return `the overlay holds ${all.length} agents (${all.join(", ")}); name one in the settings`;
}

/** Which runtime this event came from, for the trace and for the report. */
export function runtimeOf(event = {}) {
  if (event.turn_id || event.model) return "codex";
  return "claude-code";
}
