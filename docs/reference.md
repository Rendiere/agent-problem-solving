# Reference

## Where things are stored

The folder you chose at install time holds one problem file per agent and a log
of every change:

```
<folder>/agents/default/PROBLEMS.md       the problems
<folder>/agents/default/decisions.jsonl   every change, appended, never edited
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
