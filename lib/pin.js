// The pinned "📌 Registered" message a thread carries while a problem is active
// (R24, U7).
//
// The register owns the pin, never the other way round: the message id goes on
// the entry when the pin is posted, and the id stays there until the message is
// unpinned. So a close, a drop or a park has one more step than the status
// change, and this module is what names it. Without it a closed problem leaves
// its pin up and the next registration leaves the thread with two.

import { UNPIN_STATUSES } from "./register.js";

export { UNPIN_STATUSES };

/** The message id on an entry, or "" when it carries none. */
export function pinOf(problem) {
  return String(problem?.pin ?? problem?.fields?.pin ?? "").trim();
}

/**
 * What the agent still has to do about the pin after a status change, or null
 * when there is nothing to do.
 *
 * @param {object} problem the entry as parsed, before the change
 * @param {object} o
 * @param {string} o.status  the status the entry is moving to
 * @param {string} o.command the whole command that clears the field here
 * @returns {{messageId: string, thread: string, status: string, text: string}|null}
 */
export function unpinAfter(problem, { status, command = "aps set <ID> pin=" } = {}) {
  if (!UNPIN_STATUSES.includes(String(status ?? "").toLowerCase())) return null;
  const messageId = pinOf(problem);
  if (!messageId) return null;
  const id = problem.id;
  const thread = String(problem.thread ?? "").trim();
  return {
    messageId,
    thread,
    status,
    command,
    text:
      `unpin: message ${messageId}${thread ? ` in ${thread}` : ""} is still pinned for ${id}. ` +
      `Unpin it now, then clear the field with: ${command}. ` +
      "If the unpin fails, tell the operator in one line that the pin is stale and leave the field alone.",
  };
}

/** Entries that were closed, dropped or parked and still carry a pinned message. */
export function stalePins(register) {
  return (register?.problems ?? [])
    .filter((p) => UNPIN_STATUSES.includes(p.status) && pinOf(p))
    .map((p) => ({ id: p.id, title: p.title, thread: p.thread, status: p.status, messageId: pinOf(p) }));
}
