# agent-problem-solving

Agent Problem Solving is a plugin that helps you solve problems with your agent.

Use it to:

1. Clearly define a problem and what done means
2. Identify & understand available information + what (if any) is required but missing
3. Refine the problem as new information arrives
4. **NB!!** Keep the conversation on track to solve the problem.

It works with Claude Code, Codex and OpenClaw.

## What it looks like

You chat with your agent as usual. When you bring it a problem, the agent
writes the problem down before it starts, without you asking it to. When the
steps are obvious, as with adding a CSV export, it just does the work and
writes nothing down.

> **You:** Sign-ups dropped about 30% last month. Any idea why?
>
> **Agent:** Not yet, and finding out will take more than one reply, so I'd like to write it down first.
>
> P1. Find out why sign-ups fell
> - problem: sign-ups fell about 30% last month and nobody knows why
> - done when: we can name the step where the missing sign-ups drop out, with numbers from both months
> - rules out: changes to the sign-up flow until we know the cause
>
> 1. Approve 2. Reword 3. Not now
>
> **You:** 1

Half an hour later you ask for something else:

> **You:** While you're in there, can you restyle the sidebar?
>
> **Agent:** 🧭 I noticed we're veering off P1 Find out why sign-ups fell: the
> sidebar won't show where people drop out. 1. Back to it 2. Reframe 3. Park it
> and switch

When the check passes, the agent shows you the evidence and asks before it
calls the problem done. Tomorrow's session opens on the same problem, because
the problem is stored in a file that every new session reads.

## How a problem moves

![How a problem moves, from the problem you bring to done, parked or dropped](docs/problem-loop.svg)

1. You bring a problem: something is off and the way to fix it isn't obvious
   yet. A quick fact or a task with clear steps just gets answered or done. If
   you keep telling the agent a task isn't quite what you want, it suggests
   writing it down as a problem.
2. The agent drafts the problem: what is wrong, and a check anyone could run to
   prove it fixed. It waits for you.
3. You approve it, and it becomes the active problem. Each project or chat
   thread has one active problem at a time.
4. Before every reply, the agent sees the active problem and its check. If the
   conversation drifts, or you push back twice, it stops and asks whether to go
   back, reword the problem, or park it.
5. The problem ends one of three ways. Done: the check passed, you confirmed,
   and the agent saved one line on what it learned. Parked: its state is
   written down, and it comes back when you return to it. Dropped: you called
   it off.

Nothing becomes active, done or dropped without your yes.

## Install

Run the command for your agent from inside the project you want it in:

```bash
npx github:Rendiere/agent-problem-solving install claude-code
npx github:Rendiere/agent-problem-solving install codex
npx github:Rendiere/agent-problem-solving install openclaw
```

Each command installs four skills, a hook that shows the agent the active
problem before every reply, and the `aps` command the agent uses to change a
problem. The installer asks where to store your problems and suggests places near the
agent: the repository you are in, or the agent's own folder (`~/.claude`,
`~/.codex`, or the OpenClaw workspace). Pass `--overlay <path>` to choose
without the question, or `--yes` to take the first suggestion. A folder inside
your repository can be committed or added to `.gitignore`, whichever you
prefer. Add `--dry-run` to see which files would change; the installer backs up
any file before editing it.

After installing:

- Codex installs the hook switched off. Type `/hooks` once to review and trust it.
- OpenClaw needs a gateway restart.

If you run several named agents, give each its own problems with
`--agent <name>` (or `--agents a,b` for OpenClaw). With one agent you can leave
it out.

For any other agent, `npx skills add Rendiere/agent-problem-solving` installs
the skills on their own. Without the hook, the agent has to remember to read
its problems. [docs/reference.md](docs/reference.md) covers the `aps` command
and the file format.

## Licence

MIT.
