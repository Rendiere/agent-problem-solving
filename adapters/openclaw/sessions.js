// The OpenClaw side of the adapter interface (R32). The core never reads
// OpenClaw's state directly; everything runtime-shaped lives here.
//
// The interface, in full:
//   sessionSizes(agentId)      live sessions and their token totals   (built)
//   isPersonTurn(ctx, event)   see lib/classify.js                     (built)
//   sendMessage(thread, text)  post an ordinary message                (U7)
//   pin(thread, text) / unpin  one pinned message per thread           (U7)
//   buttons(thread, options)   optional number buttons                 (U7)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export function stateDir(env = process.env) {
  return env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

/**
 * Live sessions for one agent, largest first. A session counts as live when it
 * was touched inside `hours` and is not a sub-agent or cron session.
 */
export function sessionSizes(agentId, { hours = 24, dir = stateDir() } = {}) {
  const file = path.join(dir, "agents", String(agentId), "sessions", "sessions.json");
  if (!existsSync(file)) return [];
  let store;
  try {
    store = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const since = Date.now() - hours * 3600_000;
  return Object.entries(store)
    .filter(([key, e]) => !key.includes(":subagent:") && !key.includes(":cron:") && (e?.updatedAt ?? 0) >= since && Number(e?.totalTokens) > 0)
    .map(([key, e]) => ({
      session: key.match(/:topic:\d+/)?.[0].slice(1) ?? key.split(":").slice(2).join(":"),
      sessionKey: key,
      tokens: Number(e.totalTokens),
      fresh: e.totalTokensFresh !== false,
      compactions: e.compactionCount ?? 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function knownAgents({ dir = stateDir() } = {}) {
  const agents = path.join(dir, "agents");
  try {
    return readdirSync(agents, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}
