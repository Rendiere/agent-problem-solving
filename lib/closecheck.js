// The once-a-day close-check.
//
// A problem that is finished but still active sits pinned at the top of a chat
// for weeks. So once a day the agent is asked to look: does the done-when read
// as met by what it can already see? If so it runs the close-problem skill and
// asks. Nothing here closes anything; only the operator does that.

import { readFile } from "node:fs/promises";
import { selectForThread } from "./register.js";
import { withLock, writeJsonAtomic } from "./ledger.js";
import { checksPath } from "./paths.js";

// How long the operator's "keep it open" holds. Matches the week after which
// `aps report` calls an untouched problem stale: by then the evidence has had
// time to change and the question is worth asking again.
const KEEP_OPEN_DAYS = 7;

export function checkDue(sel, { date, checked = {}, actor = "person" } = {}) {
  // The check ends in a question, so it only goes out when someone is there to
  // answer it, and never on top of a question already waiting.
  if (actor !== "person") return null;
  if (sel?.pending) return null;
  const p = sel?.main;
  if (!p) return null;
  // Nothing to hold evidence against, and nothing yet to hold it against on
  // the day the operator approved it.
  if (!p.fields["done when"]) return null;
  if (p.confirmed?.date === date) return null;
  if (checked[p.id] === date) return null;
  // The operator has already answered this question on this evidence.
  if (daysSince(p.fields["keep open"], date) < KEEP_OPEN_DAYS) return null;
  return p;
}

/**
 * The whole unit both hooks want: decide whether this thread's problem is due
 * a check today, and claim the day for it. Returns the problem to ask about,
 * or null. Never throws, because a state file nobody can write is worth one
 * missed check and never the agent's reminder.
 */
export async function closeCheckFor({ overlay, agentId, register, thread, date, actor, waitMs } = {}) {
  try {
    const file = checksPath(overlay, agentId);
    // Read first so the ordinary turn, which is not due, costs no lock.
    const due = checkDue(selectForThread(register, thread), { date, checked: await readChecks(file), actor });
    if (!due) return null;
    return (await claimCheck(file, due.id, date, { waitMs })) ? due : null;
  } catch {
    return null;
  }
}

/**
 * Which problems have already had today's check. Keyed by problem id, holding
 * the day the check went out. Never throws: an unreadable file means the check
 * goes out again, which is far better than losing the turn over it.
 */
export async function readChecks(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Claim today's check on one problem. True only for the caller that wrote the
 * mark, so two runtimes serving one agent cannot both ask. A lock held by
 * someone else is a false, not a throw: the check is skipped rather than sent
 * without being written down, which would repeat it every turn.
 *
 * Yesterday's marks are kept. Two runtimes can disagree about the date, one in
 * UTC and one local, and dropping everything but the writer's own day would
 * have each erase the other's work.
 */
export async function claimCheck(file, id, date, { waitMs } = {}) {
  const won = await withLock(
    `${file}.lock`,
    async () => {
      const checked = await readChecks(file);
      if (checked[id] === date) return false;
      const floor = shiftDay(date, -1);
      const kept = Object.fromEntries(Object.entries(checked).filter(([, d]) => typeof d === "string" && d >= floor));
      kept[id] = date;
      await writeJsonAtomic(file, kept);
      return true;
    },
    waitMs === undefined ? {} : { waitMs },
  );
  return won === true;
}

/**
 * The line the hook puts in front of the turn. Short on purpose: it is what a
 * model that never opens the close-problem skill still has in front of it, so
 * it carries the evidence to look at, the three options, and whose call it is.
 */
export function closeCheckLine(problem) {
  if (!problem) return null;
  return [
    `Close-check on ${problem.id}, once today: hold its done-when against what you can already see —`,
    "the register, this thread, the repo, the PR. If it reads as met, or the problem no longer matters, run",
    "the close-problem skill here and put it to them: 1. Done 2. Drop 3. Keep open. Nothing closes without",
    "their yes. If it is clearly still open, say nothing and carry on.",
  ].join(" ");
}

/** Whole days from an ISO day to another, or Infinity if it cannot be read. */
function daysSince(from, to) {
  const a = Date.parse(`${String(from ?? "").slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(to ?? "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

/** An ISO day moved by whole days, used to keep one day either side of today. */
function shiftDay(date, days) {
  const t = Date.parse(`${String(date ?? "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return "";
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}
