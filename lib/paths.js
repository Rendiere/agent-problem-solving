// Every operator-specific path resolves against one overlay directory. The core
// holds no registers, logs, replay cases or deny-list of its own (R29–R32).
//
// Overlay layout:
//   denylist.txt                       one identifier per line
//   agents/<agentId>/PROBLEMS.md       that agent's register
//   agents/<agentId>/decisions.jsonl   that agent's append-only decision log
//   agents/<agentId>/turns.json        turn counts per day, for the R39 share
//   state/<agentId>.snapshot.json      last register the hook saw
//   state/<agentId>.checks.json        problems already close-checked today
//   replay/, reviews/, proposals/      replay cases and the reviewer's output

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseRegister, degradedNotice } from "./register.js";

export const DEFAULT_REGISTER_FILE = "PROBLEMS.md";

export function registerFileError(registerFile) {
  const name = String(registerFile ?? "");
  if (!name) return "the register file has no name";
  if (path.basename(name) !== name || name === "." || name === "..") {
    return `register file "${name}" is not a plain file name`;
  }
  return null;
}

// Config wins over the environment; APS_OVERLAY is for tests and the CLI. The
// path must be absolute: a relative one would resolve against whatever
// directory the gateway happens to be running in.
export function resolveOverlay(cfg = {}, env = process.env) {
  const raw = String(cfg.overlayPath ?? env.APS_OVERLAY ?? "").trim();
  if (!raw) return { overlay: null, reason: "no overlayPath in the plugin config and no APS_OVERLAY in the environment" };
  if (!path.isAbsolute(raw)) return { overlay: null, reason: `overlayPath "${raw}" is not an absolute path` };
  return { overlay: path.resolve(raw), reason: null };
}

// The overlay has to exist before anything is written into it, so a typo in the
// path is reported rather than quietly becoming a second, empty overlay.
export async function checkOverlay(overlay) {
  try {
    const info = await stat(overlay);
    if (!info.isDirectory()) return `overlay path is not a directory: ${overlay}`;
    return null;
  } catch (err) {
    return err?.code === "ENOENT" ? `no overlay directory at ${overlay}` : `cannot read the overlay at ${overlay}: ${err.message}`;
  }
}

// An agent id reaches here from the runtime and becomes a directory name, so a
// shape that could walk out of the overlay is refused, not rewritten.
const AGENT_ID = /^[\w][\w.-]*$/;

export function agentIdError(agentId) {
  const id = String(agentId ?? "");
  if (!id) return "no agent id on this turn";
  if (!AGENT_ID.test(id) || id === "." || id === "..") return `agent id "${id}" is not a plain name (letters, digits, dot, dash, underscore)`;
  return null;
}

export function agentDir(overlay, agentId) {
  const bad = agentIdError(agentId);
  if (bad) throw new Error(bad);
  return path.join(overlay, "agents", String(agentId));
}

export function registerPath(overlay, agentId, registerFile = DEFAULT_REGISTER_FILE) {
  const badFile = registerFileError(registerFile);
  if (badFile) throw new Error(badFile);
  return path.join(agentDir(overlay, agentId), registerFile);
}

export function ledgerPath(overlay, agentId) {
  return path.join(agentDir(overlay, agentId), "decisions.jsonl");
}

export function turnsPath(overlay, agentId) {
  return path.join(agentDir(overlay, agentId), "turns.json");
}

export function stateDir(overlay) {
  return path.join(overlay, "state");
}

export function turnPath(overlay, agentId, thread = null, sessionKey = null) {
  const bad = agentIdError(agentId);
  if (bad) throw new Error(bad);
  if (!thread) return path.join(stateDir(overlay), `${String(agentId)}.turn.json`);
  const threadHash = createHash("sha256").update(String(thread)).digest("hex").slice(0, 16);
  const sessionHash = createHash("sha256").update(String(sessionKey ?? "unknown")).digest("hex").slice(0, 16);
  return path.join(stateDir(overlay), "turns", String(agentId), threadHash, `${sessionHash}.json`);
}

export function turnDir(overlay, agentId, thread) {
  return path.dirname(turnPath(overlay, agentId, thread, null));
}

export function snapshotPath(overlay, agentId) {
  const bad = agentIdError(agentId);
  if (bad) throw new Error(bad);
  return path.join(stateDir(overlay), `${String(agentId)}.snapshot.json`);
}

export function checksPath(overlay, agentId) {
  const bad = agentIdError(agentId);
  if (bad) throw new Error(bad);
  return path.join(stateDir(overlay), `${String(agentId)}.checks.json`);
}

export function denylistPath(overlay) {
  return path.join(overlay, "denylist.txt");
}

// Never throws. A missing register is a real state (a new agent); anything else
// is a degraded read the agent has to tell the person about (R5).
export async function loadRegister(file) {
  try {
    const text = await readFile(file, "utf8");
    return { register: parseRegister(text), text, missing: false, notice: null };
  } catch (err) {
    if (err?.code === "ENOENT") return { register: null, text: null, missing: true, notice: null };
    return { register: null, text: null, missing: false, notice: degradedNotice(err?.message ?? String(err)) };
  }
}
