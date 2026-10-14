---
name: reframe
description: Use when a tripwire fires on the active problem - the operator pushes back twice in one thread, you correct yourself twice, the fix on the table is a workaround ("for now", "stopgap"), or a build is about to start.
---

# Reframe

New information means the problem statement may be wrong. Check it before doing more.

1. **Stop** this line of work for this reply.
2. **Restate** the active problem in one line, as the register has it.
3. **Say what changed**: the pushback, the correction, the evidence that the approach is a workaround.
4. **Propose** either the same problem with a new approach, or a reworded problem (problem, done when). The register's own wording is often what is wrong: if the problem is narrower than what the operator keeps asking for, widen it. A reworded entry goes back to `proposed`.
5. **Ask one question** that decides between them. When the answers are discrete, number them and add number-only buttons.

Before a build, the question is whether the build is the simplest approach that meets `done when`. If a smaller step meets it, propose that. If the fix on the table is a stop-gap, call it one and say what it leaves unsolved.

**If the reframe needs a picture**, use C4 and stop at level 1 (system context) and level 2 (containers): ten to fifteen boxes, every arrow one-way and labelled with the protocol, or the action where no protocol applies.

Keep the tripwire counts honest: `aps set <ID> pushbacks=2 corrections=1` as they happen, so they survive a reset. Once the operator answers, `aps set <ID> state="…"` and, on a reword, `status=proposed`.
