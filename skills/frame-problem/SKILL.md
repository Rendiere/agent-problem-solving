---
name: frame-problem
description: Use before starting work no active problem covers, when the person asks for a fix with no done-when in sight, or when a second attempt at the same thing fails. Drafts one register entry and asks for approval in one message.
---

# Frame a problem

Write the problem down before solving it. The order is what is wrong, then the
simplest approach that could fix it, then the goal.

1. **Read the register and the mission line.** The per-turn block names this
   thread's active problem. If an active problem already covers this, use it and
   stop here. A thread holds one problem at a time.
2. **Gather what you have.** Note what you already know and what is missing. For
   each missing piece, name how you will get it: a query, a file, a question.
3. **Draft the entry** with `status: proposed`:
   - `problem`: what is wrong or missing, in one or two sentences, with no
     solution in it.
   - `serves`: the mission metric it moves. If it moves none, say so; it may not
     be worth doing.
   - `done when`: a check anyone could run — a number in the data, a screenshot,
     a sent email. Not "it feels better".
   - `rules out`: what waits until this is done.
   - `thread`, `updated`, `state`. Add `links` for related tickets; the register
     is not the tracker, so the ticket stays where it lives.
   - `parent`: set it when this is a side task that unblocks another problem.
4. **Ask once.** Send the four lines (problem, serves, done when, rules out) and
   the simplest approach in one sentence, then the options as a numbered list:
   1. Approve  2. Reword  3. Not now. Keep it to one short message. Write
   `pending: enter <today>` on the entry so the question survives a reset.
5. **On approval** run `aps set P<n> status=active confirmed=<today>` and start.
   On "reword", edit the entry, leave it `proposed`, and ask again. On "not now",
   leave it `proposed` and clear the pending line.

Approving the entry approves the done-when with it. Do not ask about the
done-when a second time.

Only the operator moves a problem to `active`, `done` or `dropped`. Use
`aps set` for every change: it stamps the date, refuses a second active problem
on the same thread, and writes the decision log.

A proposed entry nobody has answered for three days gets restated once, in one
line, and then dropped or confirmed.

A fact, a reminder or ordinary chat needs no entry. Answer it.

## If the work needs a picture

Draw it in C4 and stop at level 1 (system context) or level 2 (containers);
never deeper. Ten to fifteen boxes per picture, and split it rather than going
past fifteen. Every arrow points one way and carries a label: the protocol where
that matters, otherwise the action.
