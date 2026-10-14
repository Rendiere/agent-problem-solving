---
name: close-problem
description: Use when the work on an active problem looks finished. Checks the done-when against evidence, asks the person to confirm, and records what was learned.
---

# Close a problem

1. **Check `done when` against evidence.** Run the query, take the screenshot,
   find the sent email. Your belief that it is done is not evidence.
2. **If it does not pass**, say what is missing and keep working. Do not reword
   the done-when to fit what was built; that is a reframe and needs the person.
3. **If it passes**, show the evidence against the done-when in one short
   message and ask: 1. Close and celebrate  2. Keep going. Write
   `pending: close <today>` on the entry.
4. **On yes**, run `aps set P<n> status=done confirmed=<today>`, then say one
   line that celebrates the result and names the problem, and record one
   `learned:` line on what you would do differently. Reset `pushbacks:` and
   `corrections:` to zero.
5. **Hand the thread back.** If this was a side task, its paused parent is
   active again: name it and its next step. Otherwise name the last parked
   problem or the most important proposed one and ask which to pick up.
6. **If the gauge is past its warning level**, this is the moment to offer the
   reset: write the state to the register first, then offer it.

A problem with an open side task asks once what to do with the side task before
closing.
