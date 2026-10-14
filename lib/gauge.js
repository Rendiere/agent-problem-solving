// Context gauge: a token count and two levels, no percentage and no ceiling
// (R20, R21, R39, KTD10). Nothing here blocks a turn; both levels prompt an offer.

export const DEFAULT_WARN_TOKENS = 250_000;
export const DEFAULT_HIGH_TOKENS = 500_000;

/**
 * The session's size, and whether the runtime has a record of this session at
 * all. No record means a fresh session; a record with no token figure means the
 * reading is unknown, which is a different thing.
 */
export function readSession(api, agentId, sessionKey) {
  try {
    const entry = api?.runtime?.agent?.session?.getSessionEntry?.({ agentId, sessionKey });
    if (!entry) return { tokens: null, fresh: true, known: false };
    const n = Number(entry.totalTokens);
    if (!Number.isFinite(n) || n <= 0) return { tokens: null, fresh: true, known: true };
    return { tokens: n, fresh: entry.totalTokensFresh !== false, known: true };
  } catch {
    // The gauge is never worth losing the reminder over.
    return { tokens: null, fresh: true, known: false };
  }
}

export function gaugeLevel(reading, { warnTokens = DEFAULT_WARN_TOKENS, highTokens = DEFAULT_HIGH_TOKENS } = {}) {
  const tokens = typeof reading === "number" ? reading : reading?.tokens;
  if (!Number.isFinite(tokens) || tokens <= 0) return "unknown";
  if (tokens >= highTokens) return "high";
  if (tokens >= warnTokens) return "warn";
  return "ok";
}

export function gaugeLine(reading, opts = {}) {
  const { warnTokens = DEFAULT_WARN_TOKENS, highTokens = DEFAULT_HIGH_TOKENS, canCompact = false, date = today(), actor = "person" } = opts;
  const r = typeof reading === "number" ? { tokens: reading, fresh: true } : reading ?? {};
  const level = gaugeLevel(r, { warnTokens, highTokens });
  if (level === "unknown") return "Context: unknown.";
  const k = (n) => `${Math.round(n / 1000)}k`;
  const base = `Context: ${k(r.tokens)} tokens${r.fresh ? "" : ", last known"}.`;
  // An automated turn records the offer instead of making it: nobody is there
  // to answer (R19).
  if (actor === "automated") {
    return level === "ok" ? base : `${base} Past ${k(level === "high" ? highTokens : warnTokens)}: write the state down, add \`pending: reset ${date}\`, and do not offer a reset on this turn.`;
  }
  const reset = canCompact ? "/new (or /compact)" : "/new";
  if (level === "high") {
    return `${base} Past ${k(highTokens)}: write the state down, add \`pending: reset ${date}\`, offer ${reset} now, even mid-problem.`;
  }
  if (level === "warn") {
    return `${base} Past ${k(warnTokens)}: at the next close, park or reframe — never mid-problem — write the state down, add \`pending: reset ${date}\`, offer ${reset}.`;
  }
  return base;
}

// Dates are the operator's local dates: a confirmation written at half past
// midnight belongs to that day, not to UTC's.
export function today(d = new Date(), timeZone = process.env.APS_TZ || undefined) {
  if (!timeZone) return localDate(d);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return localDate(d);
  }
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
