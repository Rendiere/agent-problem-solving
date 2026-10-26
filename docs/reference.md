# Reference

## Where things are stored

The folder you chose at install time holds one problem file per agent and a log
of every change:

```
<folder>/agents/default/PROBLEMS.md       the problems
<folder>/agents/default/decisions.jsonl   every change, appended, never edited
<folder>/state/default.checks.json        problems already close-checked today
<folder>/denylist.txt                     optional: names that must never reach this repository
```

`default` is the agent's name when you have not given it one. Install with
`--agent <name>` and each named agent gets its own folder beside it. Fill in
the `Mission:` line at the top of `PROBLEMS.md` with one sentence on the outcome
the project is for. The agent uses it to judge whether a problem is worth doing.

## The `aps` command

The agent runs these itself. They work by hand too, on any runtime that can read
a file and run a command.

```bash
aps set P1 status=parked state='waiting on a reply'   # change a problem; stamps the date and writes the log
aps lint                                              # check the problem file
aps report                                            # what is parked, stale or waiting on you
aps doctor                                            # check the install
aps install --status                                  # what is installed where
```

`aps set` refuses a second active problem in one thread.

## The once-a-day close-check

A problem that is finished but still active sits at the top of a chat for weeks.
So once a day the reminder carries one extra line, naming the thread's active
problem and asking the agent to hold its done-when against evidence it can
already see. If that reads as met, or the problem has stopped mattering, the
agent runs the close-problem skill in that thread and asks the operator: done,
drop, or keep open. If it is clearly still open the agent says nothing. Nothing
moves to `done` or `dropped` without the operator's yes, same as before.

There is no cron and no scheduler. The line rides on the first turn of the day
in each thread, which is the same mechanism on every runtime the plugin
supports, and it needs nothing set up beyond the install. The day the check went
out is recorded per problem in `state/<agent>.checks.json`, which holds one
day's marks and no history.

The check is skipped when:

- the turn is automated — a heartbeat or a sub-agent report has nobody to answer
- a question is already pending on the entry
- the operator confirmed the problem active that same day
- the entry has no `done when` to check against, which `aps lint` reports instead

A thread nobody opens is never checked, by design: the check rides on use. Those
surface in `aps report`, which lists what has been active and untouched for a
week.

## Session size

Where a runtime reports how many tokens a session holds, the hook shows the
agent that count against two levels. Past the first, the agent offers a fresh session
at the next natural break (a close, a park or a reframe). Past the second, it
writes the state down and offers one straight away. It never blocks a turn.

## Tests

```bash
npm test                    # the suite
APS_OVERLAY=… npm test      # also checks that none of the names in your deny-list are in this repository
```
