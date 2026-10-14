---
name: close-problem
description: Use when the work on an active problem looks finished. Checks done-when against evidence, asks the operator to confirm, and records what was learned.
---

# Close a problem

1. **Check `done when` against evidence**: run the query, take the screenshot, find the sent email. Your belief that it is done is not evidence.
2. **If it does not pass**, say what is missing and keep working. Do not reword `done when` to fit what was built; that is a reframe and it needs the operator.
3. **If it passes**, send the evidence in one short message and ask: 1. Close and celebrate 2. Keep going, with number-only buttons. Write `pending: close <date>` on the entry.
4. **On a yes**, use the complete `Change it:` command from the reminder to set `<ID> status=done learned="…" --confirmed --clear-pending`. One line on the result, one line on what you would do differently. The command hands a side task's thread back to its parent; name the parent and its next step.
5. **Offer the next one.** Name the last parked problem or the most important proposed one and ask which to pick up. If the context gauge is past its warning level, this is the moment to offer a reset.

Keep done entries in the register for a week, then move them to `PROBLEMS-archive.md`.
