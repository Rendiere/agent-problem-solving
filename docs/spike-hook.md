# Does the hook reach the model, and does it survive?

Run on OpenClaw 2026.7.1-2 with the claude-cli backend (Claude Code 2.1.293,
Opus 5.5), in an isolated profile with one throwaway agent. No live agent,
config or session was touched. The operator's raw run log is in their overlay.

**Yes.** `before_prompt_build` fires on claude-cli turns, both in an embedded
local run and through a gateway process, and the model demonstrably reads the
text: with a nonce that existed only in the register, the reply was the nonce.
With the plugin off, the same prompt returned nothing.

What else the runs showed:

- **A reset does not lose the problem.** After `/reset`, the next turn still
  named the active problem and its done-when, because the register is on disk
  and is read again from scratch.
- **The backend's own compaction does not lose it either.** With the window
  lowered, Claude Code compacted inside its own session (the prompt dropped from
  112k to 91k tokens between turns, same session id) and the following turn still
  named the problem. OpenClaw's `compactionCount` stays at 0 for those sessions
  because the compaction happens inside the backend, so judge fill from
  `totalTokens`, not from the count.
- **The CLI's embedded fallback runs no plugin hooks.** When the gateway is
  unreachable and the CLI falls back, there is no block. Channel traffic does not
  use that path.
- **Manual compaction is not available on this backend.** The gateway's
  summariser presents an older backend version, which the model API refuses. So
  the gauge offers `/new` at a problem boundary and leaves compaction to the
  backend. The `canCompact` config key exists for backends where a compact
  genuinely shrinks the session.

## Where the text goes, and what it costs

The backend's prepare step runs the prompt-build hooks and prepends
`prependContext` to the user turn. The plugin uses `prependContext` rather than
`appendSystemContext` on purpose: the system prompt is part of the live session's
fingerprint, so text that changes every turn (the gauge) would restart the
backend process and throw away its prompt cache on every message.

The block stays in the transcript, so it costs roughly its own size per turn:
about 250–300 tokens with an active problem, about 100 without, so of the order
of 28k over a hundred turns. Compaction and the daily reset clear it. Session
history search indexes it too, which adds boilerplate to recall results.

## Gotcha

Shells spawned by a running gateway inherit its port variable, which overrides
the port of any other profile. Unset it before testing against a second gateway.
