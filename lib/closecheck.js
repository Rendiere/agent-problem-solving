// The once-a-day close-check.
//
// A problem that is finished but still active sits pinned at the top of a chat
// for weeks. So once a day the agent is asked to look: does the done-when read
// as met by what it can already see? If so it runs the close-problem skill and
// asks. Nothing here closes anything; only the operator does that.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { withLock } from "./ledger.js";

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
  return p;
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
 * Record that today's check went out on one problem. Only today's date is ever
 * compared, so every earlier mark is dropped in the same write and the file
 * stays the size of one day.
 */
export async function markChecked(file, id, date, { waitMs } = {}) {
  return withLock(
    `${file}.lock`,
    async () => {
      const kept = Object.fromEntries(Object.entries(await readChecks(file)).filter(([, d]) => d === date));
      kept[id] = date;
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(kept, null, 2)}\n`, "utf8");
      await rename(tmp, file);
      return kept;
    },
    waitMs === undefined ? {} : { waitMs },
  );
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
