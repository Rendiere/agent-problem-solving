---
name: focus
description: Use when a message switches problem, drifts off the active problem, or starts a side task, when parking or resuming a problem, and when asked what is parked or how full the context is.
---

# Stay on one problem

The block at the top of every turn names this thread's active problem and ends
with a short check. This skill is the long version of that check.

| Kind | Sign | Do |
|---|---|---|
| Same problem | It moves the done-when | Carry on. |
| A switch | The message belongs to a different problem | Ask first, one line: "Park P\<n\> (\<its state\>) and switch?" Wait. Never switch unasked, even when the person started it. |
| Drift | The work no longer moves the done-when and nobody asked to switch | Open the reply with the drift line and stop. |
| A side task | The problem needs a smaller job done first | Draft it as its own entry with `parent: P\<n\>` and ask. |
| Not problem-solving | A fact, a reminder, a chat | Answer. No entry. |

Related is not the same as moving it: a question about how the tools work can be
relevant to a problem without moving its done-when. Your own drift counts too,
so name it when your next step would not move the done-when.

## The drift line

A drift reply opens with it and does nothing else until the person picks:

```
🧭 I noticed we're veering off P14 · Win the First Ten Artists: privacy-page code won't help us email the first ten artists.
Choose one:
1. Go back to the artist list.
2. Reframe the quest.
3. Park this quest and switch.
```

One line of reason may follow. Nothing else. Write `pending: drift <today>` on
the entry so the stop survives a reset or a compaction, and do no further work
on that problem until the answer comes.

The drift signals are: the person pushes back twice on this thread, you correct
yourself twice, the fix on offer is a workaround ("for now", "stopgap"), or the
next step does not move the done-when. Keep the pushback and self-correction
counts on the entry with `aps set`, so they survive a reset. The counts help you
notice; they never raise a notice on their own.

## Switching and parking

Ask in one line, naming the problem and its state: "Park the clinic booking
(waiting on their reply) and switch?" After the answer, confirm in one line:
"Parked: clinic booking. Now on: plugin requirements." Yes to a switch also
confirms resuming a problem that was already parked; a new problem still needs
its own entry question.

After "stay", note the declined request on the state line and do not ask again
about follow-ups to it.

## Side tasks

A side task becomes the thread's active problem and its parent is paused;
`aps set` applies that both ways. Before a side task would spawn its own side
task, ask whether the original problem still needs it. A sub-agent you delegate
to is not a side task and gets no entry.

## Keep the state line current

Update `state` whenever a step lands, not only when parking. A session can reset
or compact without warning, and the register on disk is what carries the problem
across.

## Answering "what's parked" and "how full is the context"

Run `aps report` and answer from it in one short message: the parked problems
with their ages, anything untouched for seven days, and the largest live
session. Do not guess either from memory.

## Context

The block shows the session's size against two levels. Past the first, offer the
reset at the next close, park or reframe — never mid-problem. Past the second,
write the state to the register and offer it straight away. The offer names the
command; the first reply in the fresh session opens with "Back on: \<problem\>".

## Defaults

- Only an explicit choice answers a pending question. Otherwise answer a fact
  or reminder, restate the same question, and keep its `pending:` line.
- Restate a pending question after 24 hours. Restate a proposed entry after
  three days.
- After the person chooses "stay", record the declined request and do not ask
  again about its follow-ups.
- When a parent closes or is dropped, ask once what to do with any open side
  task. A sub-agent run is not a side task.
- Reset `pushbacks:` and `corrections:` on park, reframe and close.
