// How full is this session?
//
// A token count against two levels, with no percentage and no ceiling. The
// gauge never blocks a turn; past each level it asks the agent to make an offer
// (R20, R21, KTD10). OpenClaw's own percentage is wrong on claude-cli, where the
// backend declares a window the gateway does not know about, so the raw count is
// the only figure worth showing.

export const DEFAULT_WARN_TOKENS = 250_000;
export const DEFAULT_HIGH_TOKENS = 500_000;

/** Read the live session's token total. Returns null when there is no figure yet. */
export function readSessionTokens(api, agentId, sessionKey) {
  try {
    const entry = api?.runtime?.agent?.session?.getSessionEntry?.({ agentId, sessionKey });
    const n = Number(entry?.totalTokens);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { tokens: n, fresh: entry?.totalTokensFresh !== false };
  } catch {
    // The gauge is never worth losing the rest of the reminder over.
    return null;
  }
}

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * @param {{tokens:number,fresh:boolean}|number|null} reading
 * @param {{warnTokens?:number, highTokens?:number, compactShrinksSession?:boolean, resetCommand?:string}} opts
 */
export function gaugeLine(reading, opts = {}) {
  const {
    warnTokens = DEFAULT_WARN_TOKENS,
    highTokens = DEFAULT_HIGH_TOKENS,
    compactShrinksSession = false,
    resetCommand = "/new",
  } = opts;
  const r = typeof reading === "number" ? { tokens: reading, fresh: true } : reading;
  if (!r) return "Context: unknown (no figure yet for this session).";

  const count = `Context: ${k(r.tokens)} tokens${r.fresh ? "" : ", last known"}.`;
  // A compact is only worth offering on a backend where compacting shrinks the
  // session. On claude-cli it does not, so the offer names a reset instead.
  const how = compactShrinksSession
    ? `${resetCommand} to start fresh, or a compact to shrink this one`
    : `${resetCommand} to start fresh`;

  if (r.tokens >= highTokens) {
    return `${count} Past the ${k(highTokens)} level: write the active problem's state to the register now, then offer the reset straight away even mid-problem. Say "${how}" and write 'pending: reset' on the entry.`;
  }
  if (r.tokens >= warnTokens) {
    return `${count} Past the ${k(warnTokens)} level: at the next close, park or reframe, write the state to the register and offer the reset. Say "${how}" and write 'pending: reset' on the entry. Not mid-problem.`;
  }
  return count;
}

/** Which band the reading sits in. The decision log counts turns per band (R39). */
export function gaugeBand(reading, opts = {}) {
  const { warnTokens = DEFAULT_WARN_TOKENS, highTokens = DEFAULT_HIGH_TOKENS } = opts;
  const r = typeof reading === "number" ? { tokens: reading } : reading;
  if (!r || !Number.isFinite(r.tokens)) return "unknown";
  if (r.tokens >= highTokens) return "high";
  if (r.tokens >= warnTokens) return "warn";
  return "ok";
}

/** Automated turns record a reset question but never offer it to the person. */
export function automatedGaugeLine(reading, opts = {}) {
  const { warnTokens = DEFAULT_WARN_TOKENS, highTokens = DEFAULT_HIGH_TOKENS } = opts;
  const r = typeof reading === "number" ? { tokens: reading, fresh: true } : reading;
  if (!r) return "Context: unknown.";
  const count = `Context: ${k(r.tokens)} tokens${r.fresh === false ? ", last known" : ""}.`;
  if (r.tokens >= highTokens) return `${count} Write \`pending: reset ${todayForGauge()}\`; do not offer it on this turn.`;
  if (r.tokens >= warnTokens) return `${count} At the next boundary write \`pending: reset ${todayForGauge()}\`; do not offer it on this turn.`;
  return count;
}

const todayForGauge = () => new Date().toISOString().slice(0, 10);
