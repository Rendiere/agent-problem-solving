// Where the plugin's files live, and how a read failure is reported.
//
// Everything operator-specific sits under one overlay directory, set as
// `overlayPath` in the plugin config. The core never hard-codes a path, a
// workspace or an agent id.
//
//   <overlay>/denylist.txt              identifiers that may not reach the core
//   <overlay>/agents/<agent>/PROBLEMS.md    that agent's register
//   <overlay>/agents/<agent>/decisions.jsonl  that agent's decision log

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseRegister } from "./register.js";

export const DEFAULT_REGISTER_FILE = "PROBLEMS.md";
export const LOG_FILE = "decisions.jsonl";
export const DENYLIST_FILE = "denylist.txt";

export function overlayRoot(cfg = {}) {
  // The hook accepts only its plugin config. The CLI resolves APS_OVERLAY and
  // passes it in explicitly, so a gateway process environment cannot silently
  // opt an agent into a different overlay.
  const p = String(cfg.overlayPath ?? "").trim();
  return p && path.isAbsolute(p) ? path.resolve(p) : "";
}

const AGENT_ID = /^[\w][\w.-]*$/;

export function agentIdError(agentId) {
  const id = String(agentId ?? "");
  if (!id) return "no agent id on this turn";
  if (!AGENT_ID.test(id) || id === "." || id === "..") {
    return `agent id "${id}" is not a plain name`;
  }
  return "";
}

export function agentDir(cfg, agentId) {
  const root = overlayRoot(cfg);
  return root && !agentIdError(agentId) ? path.join(root, "agents", String(agentId)) : "";
}

export function registerPath(cfg, agentId) {
  const dir = agentDir(cfg, agentId);
  return dir ? path.join(dir, cfg.registerFile ?? DEFAULT_REGISTER_FILE) : "";
}

export function logPath(cfg, agentId) {
  const dir = agentDir(cfg, agentId);
  return dir ? path.join(dir, LOG_FILE) : "";
}

export function denylistPath(cfg) {
  const root = overlayRoot(cfg);
  return root ? path.join(root, DENYLIST_FILE) : "";
}

function why(err, file) {
  if (err?.code === "ENOENT") return `no file at ${file}`;
  if (err?.code === "EACCES") return `no permission to read ${file}`;
  if (err?.code === "EISDIR") return `${file} is a directory`;
  return `${err?.code ?? "error"} reading ${file}: ${err?.message ?? err}`;
}

/**
 * Read one agent's register. Never throws: a failure comes back as a one-line
 * `degraded` reason the reminder shows the agent, so a broken file is visible
 * instead of looking like "no problem" (R5).
 */
export async function readRegister(cfg, agentId) {
  const configured = String(cfg?.overlayPath ?? "").trim();
  if (configured && !path.isAbsolute(configured)) {
    return { ok: false, file: "", degraded: `overlayPath must be absolute: ${configured}` };
  }
  const badAgent = agentIdError(agentId);
  if (badAgent) return { ok: false, file: "", degraded: badAgent };
  const root = overlayRoot(cfg);
  if (root) {
    try {
      if (!(await stat(root)).isDirectory()) return { ok: false, file: root, degraded: `overlayPath is not a directory: ${root}` };
    } catch (err) {
      return { ok: false, file: root, degraded: why(err, root) };
    }
  }
  const file = registerPath(cfg, agentId);
  if (!file) {
    return { ok: false, file: "", degraded: "no overlayPath is set in the plugin config" };
  }
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return { ok: false, file, degraded: why(err, file) };
  }
  try {
    return { ok: true, file, register: parseRegister(text), text };
  } catch (err) {
    return { ok: false, file, degraded: `cannot parse ${file}: ${err?.message ?? err}` };
  }
}
