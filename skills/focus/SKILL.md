---
name: focus
description: Use when a message switches problem, drifts off the active one, or starts a side task, when parking or resuming, and when asked what is parked or how full the session is.
---

# Stay on one problem

The block at the top of each turn names this thread's problem and ends with a short check. This skill is the longer version of that check.

| Kind | Sign | Do |
|---|---|---|
| Same problem | It moves `done when` | Carry on. |
| Deliberate switch | The operator asks for other work | Ask in one line: "Park <ID> (<state>) and switch?", options 1. Park and switch 2. Stay. Write `pending: switch <date>`. On a yes, use the complete `Change it:` command from the reminder to set `<ID> status=parked state="…"`, then make the other problem active. One line confirms it: "Parked: <a>. Now on: <b>." |
| Drift | The work no longer moves `done when`, and nobody asked for that | Open the reply with "🧭 I noticed we're veering off <ID title>: <what pulled us away>", then 1. Go back to the quest 2. Reframe it 3. Park it and switch. Write `pending: drift <date>` and do no further work on this thread until they answer. |
| Not problem-solving | A fact, a reminder, chat | Answer. No entry. |

A task whose steps you could write down now gets no entry of its own, unless it is a side task that unblocks the active problem (see below). While a problem is active, a task that does not move `done when` is still a switch or drift, so ask before doing it.

Related is not the same as moving it: a question about how the tools work can be relevant to a problem without moving its `done when`. Your own drift counts too, so name it when your next step would not move `done when`.

## Side tasks

A side task started to unblock a problem is its child: draft it with `parent: <ID>`. Once the operator confirms, use the reminder's complete `Change it:` command to set `<child> status=active --confirmed`; that pauses the parent and gives the thread to the child. Closing or dropping the child hands the thread back. Before a child would start its own child, ask whether the original problem still needs it.

## Keep the state line current

`aps set <ID> state="…"` whenever a step lands, not only when parking. Sessions reset and compact without warning, and the register on disk is what carries the problem across. Before a reset, write the state down.

## Answering "what's parked" and "how full is the session"

Run `aps report` and answer in one short message: the parked problems with their age, anything untouched for a week, any question still waiting, and the largest live session. Do not paste the whole report.

## Defaults

- Only an explicit choice answers an open question. Anything else leaves the `pending:` line where it is; restate the question in one line.
- Restate an unanswered question after 24 hours, and a proposed entry after three days.
- After a "stay", note the declined request in `state` and do not ask about it again.
- Reset `pushbacks` and `corrections` to 0 on a park, a reframe or a close.
- When a parent closes or is dropped with an open side task, ask once what happens to the side task.
- A sub-agent you dispatch is not a side task: it is work on this problem.

## Context

The block shows the session's size against two levels. Past the first, wait for the next close, park or reframe, write the state down, then offer a reset. Past the second, write the state down and offer the reset straight away, even mid-problem.
