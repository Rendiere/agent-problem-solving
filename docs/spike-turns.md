# Telling the person's turns from automated ones

**Status: partial.** The rule below is implemented and tested, and the hook's
own firing is observed live. The `trigger` values for a heartbeat, a cron run
and a button tap, and the provenance on a sub-agent completion report landing in
a parent session, are read from the runtime's types and sources rather than
watched on a live gateway. Until a day of `APS_TRACE_FILE` traffic has been
reviewed, treat the classifier as unproven on those four shapes; that review is
a gate before the first rollout.

The reminder prompts the person on a turn from the person, and must never prompt
on a cron, a heartbeat or a sub-agent's completion report, because nobody is
there to answer (R19). So the plugin needs a field it can trust.

## What the runtime gives the hook

`before_prompt_build` receives `(event, ctx)`. On OpenClaw 2026.7.1 these are the
fields that bear on the question:

| Where | Field | Use |
|---|---|---|
| `ctx` | `trigger` | `"user"` for a channel message, `"heartbeat"`, `"cron"`, `"memory"`, `"manual"` and a set of internal values (`budget`, `overflow`, `timeout_recovery`, `diagnostics`) for everything else. |
| `ctx` | `senderId`, `channelContext.sender` | The channel's sender identity, set on channel-originated runs only. |
| `ctx` | `channel`, `messageProvider`, `chatId` | Which channel the run came from. |
| `event` | `messages[]` | The session messages for this run. The newest user message carries `provenance`. |
| `event` | `prompt` | The text of the turn. |

`provenance.kind` is one of `external_user`, `inter_session` or
`internal_system`. Anything routed in from another session or an internal tool —
a sub-agent's completion report, an inter-session send, a generated-media
callback — is marked `inter_session`, with `provenance.sourceTool` naming the
tool (`subagent_announce`, `sessions_send`, `agent_harness_task`). The same runs
get a text header on the prompt:

```
[Inter-session message] sourceSession=<key> sourceChannel=<channel> sourceTool=<tool> isUser=false
```

That answers the stop condition in the plan: a completion report is marked, in
two independent places, and neither depends on guessing from the text.

## The rule

`lib/classify.js` defaults to automated and calls a turn the person's only with
all three of:

1. `ctx.trigger === "user"`,
2. a channel sender (`ctx.senderId` or `ctx.channelContext.sender.id`),
3. no routed-input marker — neither an `inter_session` or `internal_system`
   provenance on the newest user message, nor the `[Inter-session message]`
   header on the prompt.

Consequences worth stating plainly:

- A heartbeat or cron turn has no channel sender and a non-user trigger, so it is
  automated twice over.
- A sub-agent completion report arrives on a `user` trigger in the parent's
  channel session, with a sender; the provenance is what catches it.
- A CLI run (`openclaw agent --message`) is automated. It has no channel sender.
  A person at a terminal therefore gets the short block. That is the safe way to
  be wrong.
- A number-button tap in a forum topic reaches the agent as an ordinary channel
  message, so it classifies as the person's.

## What is observed and what is read

Observed: the hook fires on every claude-cli turn, in an embedded run and
through a real gateway, and survives a reset and the backend's own compaction
(see `spike-hook.md`); an inter-session turn carries the header above.

Read from the runtime's own types and sources, not yet observed live: the
`trigger` value on a heartbeat, on a cron run and on a button tap, and the
`provenance` on a sub-agent completion report as it lands in a parent session.

How the rest gets confirmed: set `APS_TRACE_FILE` on the gateway before the
first rollout. Every turn then appends its `trigger`, `sessionKey`, `channel`,
`senderId` and the classification to that file, so one day of real traffic shows
whether any turn was called wrong. Check it before trusting the short block.
