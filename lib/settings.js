// Where the command-line runtimes find their settings.
//
// OpenClaw hands the plugin a config object. Claude Code and Codex hand a hook
// nothing but the event, so the hook needs the overlay path from somewhere that
// survives a new session. `aps install` writes it here, which is why a person
// installs with one command and sets no environment variable by hand.

import { readFileSync, mkdirSync, openSync, closeSync, statSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

export function settingsDir(env = process.env) {
  if (env.APS_CONFIG_HOME) return path.resolve(env.APS_CONFIG_HOME);
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(env.XDG_CONFIG_HOME), "aps");
  return path.join(os.homedir(), ".config", "aps");
}

export const settingsPath = (env = process.env) => path.join(settingsDir(env), "config.json");

/** Claim one prompt so a bundled hook and a user-level hook cannot both inject. */
export function claimTurn(event, env = process.env, overlayPath = null) {
  // cwd included: the same session can send the same prompt text from two
  // different projects (two different threads), and that is two turns, not one.
  const raw = `${event?.session_id ?? ""}\0${event?.turn_id ?? ""}\0${event?.cwd ?? ""}\0${event?.prompt ?? ""}`;
  if (!raw.replaceAll("\0", "")) return true;
  const dir = overlayPath && existsSync(overlayPath)
    ? path.join(path.resolve(overlayPath), "state", "hook-claims")
    : path.join(settingsDir(env), "claims");
  const file = path.join(dir, createHash("sha256").update(raw).digest("hex"));
  try { mkdirSync(dir, { recursive: true }); } catch { return true; }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return true;
      try {
        if (Date.now() - statSync(file).mtimeMs < 200) return false;
        rmSync(file, { force: true });
      } catch { return true; }
    }
  }
  return false;
}

/** Never throws. No settings and unreadable settings are both "nothing set". */
export function readSettings(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(settingsPath(env), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * The config the hook runs on. The environment wins over the file, so a single
 * run can be pointed at a different overlay without editing anything.
 */
export function runtimeConfig(env = process.env) {
  const file = readSettings(env);
  const pick = (name, key) => {
    const fromEnv = String(env[name] ?? "").trim();
    return fromEnv || (typeof file[key] === "string" ? file[key].trim() : "") || undefined;
  };
  const num = (name, key) => {
    const raw = env[name] ?? file[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const list = (name, key) => {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim()) return raw.split(":").map((s) => s.trim()).filter(Boolean);
    return Array.isArray(file[key]) ? file[key].filter((s) => typeof s === "string" && s.trim()) : [];
  };
  return {
    overlayPath: pick("APS_OVERLAY", "overlayPath"),
    // Directories the reminder is wanted in. Empty means all of them.
    projects: list("APS_PROJECTS", "projects"),
    agentId: pick("APS_AGENT", "agentId"),
    registerFile: pick("APS_REGISTER", "registerFile"),
    timeZone: pick("APS_TZ", "timeZone"),
    warnTokens: num("APS_WARN_TOKENS", "warnTokens"),
    highTokens: num("APS_HIGH_TOKENS", "highTokens"),
  };
}
