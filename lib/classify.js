// Is this turn the person's, or did a machine start it?
//
// The answer decides whether the agent may put a question to the person. An
// automated turn writes down what it would have asked instead (R19), so a
// wrong "the person" reading interrupts nobody's chat with a prompt nothing
// will answer, and a wrong "automated" reading hides a drift notice.
//
// Automated is the default. A turn counts as the person's only on positive
// evidence (KTD7). The markers come from docs/spike-turns.md.

/** Session scopes no person ever types into. */
const MACHINE_SCOPE = /:(subagent|cron|job|task|heartbeat):/i;

/** A turn the person started carries a bare UUID; a machine-started one is prefixed. */
const SCHEMED_RUN_ID = /^[a-z][a-z0-9_-]*:/i;

/** OpenClaw's envelope on a turn routed in from another session or an internal tool. */
const INTER_SESSION = /^\s*\[Inter-session message\]/;
const IS_USER_FALSE = /\bisUser\s*=\s*false\b/;
const IS_USER_TRUE = /\bisUser\s*=\s*true\b/;

export const PERSON = "person";
export const AUTOMATED = "automated";

function promptOf(event) {
  const p = event?.prompt;
  return typeof p === "string" ? p : "";
}

/**
 * @returns {{ kind: "person"|"automated", why: string }}
 */
export function classifyTurn(event, ctx) {
  const trigger = String(ctx?.trigger ?? "").toLowerCase();
  const sessionKey = String(ctx?.sessionKey ?? "");
  const runId = String(ctx?.runId ?? "");
  const prompt = promptOf(event);

  // A routed turn states its own origin. OpenClaw's flag outranks everything else.
  if (INTER_SESSION.test(prompt)) {
    if (IS_USER_FALSE.test(prompt)) return { kind: AUTOMATED, why: "inter-session, isUser=false" };
    if (IS_USER_TRUE.test(prompt)) return { kind: PERSON, why: "inter-session, isUser=true" };
    return { kind: AUTOMATED, why: "inter-session, origin unstated" };
  }

  if (trigger && trigger !== "user") return { kind: AUTOMATED, why: `trigger ${trigger}` };
  if (!trigger) return { kind: AUTOMATED, why: "no trigger" };
  if (MACHINE_SCOPE.test(sessionKey)) return { kind: AUTOMATED, why: "machine session scope" };
  if (SCHEMED_RUN_ID.test(runId)) {
    return { kind: AUTOMATED, why: `run id scheme ${runId.slice(0, runId.indexOf(":"))}` };
  }
  return { kind: PERSON, why: "user trigger on a conversation session" };
}

export const isPersonTurn = (event, ctx) => classifyTurn(event, ctx).kind === PERSON;
