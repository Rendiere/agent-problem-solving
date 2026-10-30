---
name: frame-problem
description: Use when the operator brings a problem, a gap between where things are and where they want them with no obvious route to close it, or when their feedback on a task keeps saying it isn't quite what they want. Not for a task whose steps you could write down now, except a side task's child entry. Drafts one register entry and asks the operator to confirm it in one message.
---

# Frame a problem

Write the problem down before solving it. The order is what is wrong, the simplest approach that could meet it, then the goal.

**Problem or task.** A problem is a gap between where things are and where the operator wants them, and the route to closing it isn't obvious: it needs options, probably more than one sitting, and a clear done-when. "Sign-ups dropped 30% last month and we don't know why" is a problem. A task is work whose steps you could write down now, like "add a CSV export to the homepage": do it and register nothing.

**When a task turns out to be a problem.** If you are carrying out a task and the operator keeps telling you the result isn't quite what they want, the goal isn't understood yet. Say so and propose framing it as a problem.

1. **Read the register and the mission line.** If an active problem already covers this, use it and stop here.
2. **Gather what you have.** Note what you already know and what is missing. For each missing piece, name how you will get it: a query, a file, a question.
3. **Draft the entry** with `status: proposed`:
   - `problem`: what is wrong or missing, in one or two sentences, with no solution in it.
   - `serves`: the mission metric it moves. If it moves none, say so; it may not be worth doing.
   - `done when`: checks anyone could run — a number in the data, a screenshot, a sent email. Store several checks in one field, separated by semicolons.
   - `rules out`: what waits until this is done.
   - `thread`, `updated`, `state`, and `links` for any ticket it relates to.
   - `parent`: set it when this is a side task that unblocks another problem.
4. **Ask once.** Send one short Telegram-safe Markdown message with blank lines between sections. Use this shape and omit no section:

   ```markdown
   🎯 **Problem**
   > _<problem>_

   🧭 **Serves**
   <mission metric>

   ✅ **Done when**
   - [ ] <check one>
   - [ ] <check two>

   🚧 **Out of scope**
   <rules out>

   💡 **Approach**
   <simplest approach>

   1. Approve
   2. Reword
   3. Not now
   ```

   Put every done-when check on its own checklist line. Add number-only buttons when the runtime supports them. Write `pending: enter <date>` on the entry so the question survives a reset, and start no work on it until they answer.
5. **On approval, register first.** Use the complete `Change it:` command from the reminder with `set <ID> status=active --confirmed --clear-pending`. The command carries the current thread and session, which is how the log proves who confirmed it. Do not start work or send another status until the command succeeds.
6. **Send and pin the commitment.** Send one registered message in this shape:

   ```markdown
   📌 **Registered**
   > _<ID> — <title>_

   I am committing to solve this problem in this topic.

   🎯 **Problem**
   > _<problem>_

   ✅ **Done when**
   - [ ] <check one>
   - [ ] <check two>

   🚧 **Out of scope**
   <rules out>
   ```

   In an OpenClaw Telegram session, send it through the message tool to the current chat and topic with the current agent's `accountId` and `delivery: { pin: { enabled: true, required: true } }`. The required pin makes pin failure visible. After success, tell the operator: `Pinned in this topic.` If the call reports a pin failure, do not resend the registered message; say: `The problem is registered, but pinning failed: <plain reason>.` Never claim it is pinned without a successful tool result. Where the runtime has no delivery-pin capability, send the registered message and say that pinning is unavailable there.

   **Write the pinned message's id down.** As soon as the send returns it, record it on the entry with `set <ID> pin=<message id>`. That id is what the close unpins; without it the pin stays up and the next registration leaves the thread with two.

On "reword", edit the entry and ask again. On "not now", leave it `proposed` and clear the pending line.

A thread holds one active problem. If a second one is needed here, ask which to park. Only the operator moves a problem to active, done or dropped.

A fact, a reminder, chat or a task needs no entry: answer it or do it.

**If the problem or the approach needs a picture**, use C4 and stop at level 1 (system context) and level 2 (containers). Ten to fifteen boxes per picture; split it rather than crowd it. Every arrow points one way and carries a label: the protocol where that matters, otherwise the action.
