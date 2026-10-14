# Spike: how does the hook tell the person's turns from automated ones?

14 October 2026. OpenClaw 2026.7.1-2, Claude Code backend, model `claude-cli/claude-opus-5-5`.
Run in an isolated profile with one throwaway agent and a trace-only plugin that
recorded `before_prompt_build`'s event and context for every turn. No live agent,
config or session was touched.

**Verdict: yes, with two independent markers.** `trigger`, `sessionKey` and
`senderId` alone cannot separate a sub-agent completion report from a real
message: both arrive with `trigger: "user"` on the parent's own session key. The
report is marked in two other places, and either one is enough.

## What was observed

| Turn kind | `ctx.trigger` | `ctx.sessionKey` | `ctx.runId` | `event.prompt` opens with |
|---|---|---|---|---|
| A person's message | `user` | the conversation session | a bare UUID | the message |
| Cron run | `cron` | `agent:<id>:cron:<job>:run:<run>` | a bare UUID | `[cron:<job> <name>]` |
| Sub-agent's own run | `user` | `agent:<id>:subagent:<uuid>` | a bare UUID | `[Subagent Context]` |
| Sub-agent completion report, landing in the parent | `user` | **the parent's conversation session** | `announce:v1:<child session>:<child run>` | `[Inter-session message] … isUser=false … sourceTool=subagent_announce` |

Two turns one second apart, same agent, same session key, same trigger, same
(absent) sender: the person's message at 09:13:18 and the completion report at
09:13:37. The only fields that differ are `runId` and the prompt's opening.

`senderId` was undefined on every turn in this spike, including the person's,
because a CLI-originated turn has no channel sender. So a present sender is
positive evidence of a person, but an absent one proves nothing.

## The two markers

1. **The prompt's inter-session envelope.** A routed turn opens with
   `[Inter-session message]` and carries `isUser=false`. That flag is OpenClaw's
   own classification of the turn, which makes it the primary marker. A routed
   turn from another session with `isUser=true` is a person's message relayed
   across sessions and stays the person's.
2. **The run id's scheme prefix.** A turn the person started carries a bare
   UUID. A machine-started turn carries a prefixed id: `announce:v1:…` for a
   completion report, `manual:<job>:…` for a cron job run by hand. Anything
   before a `:` in the run id means the turn was not typed by a person.

## What the classifier does with this

Automated is the default; a turn is the person's only on positive evidence
(KTD7). The design does not rest on knowing every trigger string, so a trigger
value this spike did not see cannot be mistaken for a person.

A heartbeat did not fire during the spike: heartbeats need a delivery route and
the isolated profile had none. It is handled by the default rather than by a
match, so the gap does not weaken the classifier. The same holds for an inline
button tap, which arrives as an ordinary inbound channel message with a real
sender and no inter-session envelope.

## Gotcha

A plugin manifest without a `configSchema` fails config validation at gateway
start with `plugins: plugin: plugin manifest requires configSchema`. Every
manifest needs one, even an empty object schema.
