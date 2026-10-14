// Tell the person's turns from automated ones (R19, KTD7).
//
// The default is automated. A turn counts as the person's only with positive
// evidence: a user trigger, a channel sender, and no sign that the text was
// routed in from another session or an internal tool. Getting this wrong the
// safe way costs a shorter reminder; getting it wrong the other way prompts a
// person who is not there.

const PERSON_TRIGGERS = new Set(["user"]);

// OpenClaw marks routed input on the newest user message and in the prompt text.
const INTER_SESSION_PREFIX = "[Inter-session message]";
const ROUTED_KINDS = new Set(["inter_session", "internal_system"]);

function senderOf(ctx) {
  const c = ctx?.channelContext ?? {};
  return ctx?.senderId ?? c.sender?.id ?? c.sender?.userId ?? c.senderId ?? null;
}

function newestUserMessage(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && typeof m === "object" && m.role === "user") return m;
  }
  return null;
}

export function classifyTurn(ctx = {}, event = {}) {
  const trigger = String(ctx?.trigger ?? "").toLowerCase();
  const sender = senderOf(ctx);
  const channel = ctx?.channel ?? ctx?.messageProvider ?? null;
  const provenance = newestUserMessage(event)?.provenance?.kind ?? null;
  const prompt = String(event?.prompt ?? "");
  const routed = ROUTED_KINDS.has(String(provenance ?? "")) || prompt.startsWith(INTER_SESSION_PREFIX);

  const evidence = { trigger: trigger || null, sender: sender ? "present" : "absent", channel, provenance, routed };
  if (routed) return { actor: "automated", reason: "the text was routed in from another session or an internal tool", evidence };
  if (!PERSON_TRIGGERS.has(trigger)) return { actor: "automated", reason: `trigger "${trigger || "none"}" is not a turn from the person`, evidence };
  if (!sender) return { actor: "automated", reason: "no channel sender on the turn", evidence };
  return { actor: "person", reason: "user trigger with a channel sender and no routed-input marker", evidence };
}

export const isPersonTurn = (ctx, event) => classifyTurn(ctx, event).actor === "person";
