---
name: frame-problem
description: Use before starting work that no active problem covers, when the operator asks for a fix with no done-when in sight, or when a second attempt at the same thing fails. Drafts one register entry and asks the operator to confirm it in one message.
---

# Frame a problem

Write the problem down before solving it. The order is what is wrong, the simplest approach that could meet it, then the goal.

1. **Read the register and the mission line.** If an active problem already covers this, use it and stop here.
2. **Gather what you have.** Note what you already know and what is missing. For each missing piece, name how you will get it: a query, a file, a question.
3. **Draft the entry** with `status: proposed`:
   - `problem`: what is wrong or missing, in one or two sentences, with no solution in it.
   - `serves`: the mission metric it moves. If it moves none, say so; it may not be worth doing.
   - `done when`: a check anyone could run — a number in the data, a screenshot, a sent email.
   - `rules out`: what waits until this is done.
   - `thread`, `updated`, `state`, and `links` for any ticket it relates to.
   - `parent`: set it when this is a side task that unblocks another problem.
4. **Ask once.** Send the four lines (problem, serves, done when, rules out) and the simplest approach in one sentence, then the options as a numbered list — 1. Approve 2. Reword 3. Not now — with number-only buttons. Keep it to one short message. Write `pending: enter <date>` on the entry so the question survives a reset, and start no work on it until they answer.
5. **On approval**, use the complete `Change it:` command from the reminder with `set <ID> status=active --confirmed --clear-pending`, then carry on. The command carries the current thread and session, which is how the log proves who confirmed it. On "reword", edit the entry and ask again. On "not now", leave it `proposed` and clear the pending line.

A thread holds one active problem. If a second one is needed here, ask which to park. Only the operator moves a problem to active, done or dropped.

A fact, a reminder or chat needs no entry: answer it. Anything that takes more than a direct answer gets an entry first.

**If the problem or the approach needs a picture**, use C4 and stop at level 1 (system context) and level 2 (containers). Ten to fifteen boxes per picture; split it rather than crowd it. Every arrow points one way and carries a label: the protocol where that matters, otherwise the action.
