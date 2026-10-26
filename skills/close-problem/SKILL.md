---
name: close-problem
description: Use when the work on an active problem looks finished, or when the reminder raises the once-a-day close-check. Checks done-when against evidence, asks the operator to confirm, and records what was learned.
---

# Close a problem

1. **Check `done when` against evidence**: run the query, take the screenshot, find the sent email. Your belief that it is done is not evidence.
2. **If it does not pass**, say what is missing and keep working. Do not reword `done when` to fit what was built; that is a reframe and it needs the operator.
3. **If it passes**, send the evidence in one short message and ask: 1. Close and celebrate 2. Keep going, with number-only buttons. Write `pending: close <date>` on the entry.
4. **On a yes**, use the complete `Change it:` command from the reminder to set `<ID> status=done learned="…" --confirmed --clear-pending`. One line on the result, one line on what you would do differently. The command hands a side task's thread back to its parent; name the parent and its next step.
5. **Offer the next one.** Name the last parked problem or the most important proposed one and ask which to pick up. If the context gauge is past its warning level, this is the moment to offer a reset.

Keep done entries in the register for a week, then move them to `PROBLEMS-archive.md`.

## The once-a-day close-check

Once a day the reminder carries a `Close-check on <ID>` line for the problem
holding this thread. A problem that is finished, or that stopped mattering,
otherwise sits at the top of the chat for weeks. The check is how it comes off.

Read the done-when against evidence already in front of you. No new work, and
nothing the operator has to fetch for you:

- the entry in the register: its `done when`, `state` and `learned` lines
- the recent messages in this thread, including what you reported finished
- the repository or the pull request: the branch, the merge, the tests, the
  deployed change

Then one of three things happens.

- **It reads as met.** Go to step 1 above and check it properly. The daily check
  is a prompt to look, not evidence on its own.
- **It no longer matters**: the thing it was for is gone, or the operator moved
  on. Say so in one line, with why, and ask: 1. Done 2. Drop 3. Keep open.
  On a drop, `<ID> status=dropped learned="…" --confirmed --clear-pending`.
- **It is clearly still open.** Say nothing about it and get on with the work. A
  daily check that comments every day is a daily nag.

Whichever way you ask, write `pending: close <date>` on the entry, so the
question survives a new session. Nothing closes without their yes: never set
`status=done` or `status=dropped` without `--confirmed` and an answer to point
at.

The reminder raises the check on the first turn of the day in each thread, so
each thread's own problem gets looked at on a day it sees any use. A thread
nobody opens goes quiet instead; `aps report` lists what has been active and
untouched for a week, which is where those surface.
