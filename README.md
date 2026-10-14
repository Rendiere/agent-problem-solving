# agent-problem-solving

An OpenClaw plugin that keeps a chat agent on one named problem at a time, and
puts that problem in front of it on every turn.

A long-running chat agent can answer the latest message well and lose the
problem behind it. Drift starts when the model stops noticing the problem, so
the reminder cannot depend on the agent remembering to look.

This plugin reads a register off disk every turn and prepends the state to the
prompt: the agent's mission, which problem this thread is on, its done-when, any
question still waiting for an answer, and how full the session is. Every status
change goes to an append-only log.

Early work. The pieces below are built and tested; the chat interface and the
weekly reviewer are not.

## How it fits together

- **A register per agent.** One markdown file: a mission line and the few
  problems that agent is working on now. A thread holds at most one active
  problem. Backlog tickets stay in their existing tracker and the problem links
  to them.
- **One command.** `aps set` changes a status, stamps the date, refuses a second
  active problem on one thread, pauses and resumes a side task's parent, and
  writes the decision log. It needs no gateway, so the method works on any
  runtime that can read a file and run a command.
- **A reminder on every turn.** The plugin's hook reads the register and
  prepends about 300 tokens. An automated turn — a cron run, a heartbeat, a
  sub-agent's completion report — gets a shorter block and is told to ask nobody;
  it writes down what it would have asked instead.
- **Four skills.** `frame-problem` before starting work no problem covers,
  `focus` on a switch, a drift or a side task, `reframe` when a tripwire fires,
  `close-problem` when the done-when looks met.

## Core and overlay

This repository is the core: the method, the skills, the hook, the formats, the
scorer and the replay harness. Nothing in it names a person, an agent, a chat or
a business.

Your own missions, registers, decision logs and replay cases live in an overlay
directory you keep privately, named in `overlayPath`. A deny-list in that overlay
lists your identifiers, and a commit hook on your side of the line refuses any
commit that puts one of them in here.

```
<overlay>/denylist.txt
<overlay>/agents/<agent-id>/PROBLEMS.md
<overlay>/agents/<agent-id>/decisions.jsonl
```

## Install

```json5
{
  plugins: {
    load: { paths: ["/path/to/agent-problem-solving"] },
    entries: {
      "agent-problem-solving": {
        enabled: true,
        config: {
          agents: ["<agent-id>"],
          overlayPath: "/path/to/your/overlay",
          warnTokens: 250000,
          highTokens: 500000,
        },
      },
    },
  },
}
```

Then create `<overlay>/agents/<agent-id>/PROBLEMS.md` from
`templates/PROBLEMS.md`, put your mission in its one `Mission:` line, and check
the install:

```bash
export APS_OVERLAY=/path/to/your/overlay
node bin/aps.mjs doctor
```

Leave `agents` out to run for every agent on the gateway. The skills load for
every agent either way and do nothing where there is no register.

## Commands

```bash
aps set P4 status=parked state='waiting on their reply'   # change a status
aps add "Win the first ten artists" thread=topic:9 done-when='ten sent'
aps lint                                                 # are the registers valid?
aps report [--json]                                      # parked, stale, waiting, sizes
aps doctor                                               # is the install sound?
```

`aps report` is what you read in whatever evening routine you already have. The
core does not decide where it goes.

## Context

The gauge shows a token count against two levels and nothing else: no
percentage, no ceiling, and it never blocks a turn. Past the first level the
agent offers a fresh session at the next problem boundary — a close, a park or a
reframe. Past the second it writes the problem's state down and offers straight
away. Because the register is on disk and read again every turn, a reset or a
compaction costs nothing: the next reply opens by naming the problem it is back
on.

A compact is only offered on a backend where compacting actually shrinks the
session. On Claude Code it does not, so the offer names a reset.

## Verification

```bash
npm test                                     # 104 tests
APS_OVERLAY=… node bin/denylist-check.mjs    # nothing of yours is in here
python3 replay/run.py <overlay>/replay/cases <out> --split tuning
```

The replay runs one reply at a decision point twice, with the plugin and
without, and scores both blind against the same rubric. Cases are built from real
conversations, so they live in the overlay. `scorer/` holds the rubric and the
judge, and the weekly reviewer will import the same module, so a score means the
same thing in both places.

Two spike records sit in `docs/`: whether the hook fires on this backend at all,
and how a turn the person took is told apart from one a machine started. The
second one matters more than it sounds — a sub-agent's completion report arrives
on the parent's own session key with the same trigger as a real message, so the
classifier reads the run id and the prompt's envelope instead.

## Not in here

Replacing your tracker. Adapters for other chat apps or runtimes — the interface
is there, and whoever needs one builds it. A fixed context ceiling. Anything
that applies a change without the operator approving it.

## Licence

MIT.
