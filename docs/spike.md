# Spike: does the hook fire on claude-cli?

13 Oct 2026, OpenClaw 2026.7.1-2, Claude Code 2.1.293, model `claude-cli/claude-opus-5-5`. Run in an isolated profile (`openclaw --profile apsspike`, state in `~/.openclaw-apsspike`) with one throwaway agent `spike`. No live agent, config or session was changed. Two client calls (runs 5 and 6) did reach the live gateway on :18789 by mistake, through an inherited environment variable, and its auth check rejected them. Raw runs: `.scratch/aps-spike/`.

**Verdict: yes.** `before_prompt_build` fires on claude-cli turns, both embedded (`agent --local`) and through a real gateway process, and the model sees the injected text.

| Run | Path | Plugin | Result |
|---|---|---|---|
| 1 | `agent --local`, new session | on | Reply = the nonce, which existed only in `PROBLEMS.md`. `finalPromptText` starts with `[problem register]`. |
| 2 | same session, resumed | on | Injection present again; the gauge read 68k from the session store. The skills folders were still empty, so the agent listed no plugin skills. |
| 3 | same session, after the skills were written | on | The agent lists `frame-problem`, `reframe`, `close-problem` and `focus`. |
| 4 | `agent --local`, new session | **off** | Reply `NONE`; no injection. Control. |
| 6 | `agent`, gateway unreachable, embedded fallback, new session | on | Reply `NONE`; no injection. The CLI's embedded fallback doesn't run plugin hooks. Channel traffic doesn't use this path. |
| 7 | spike gateway on :19555, `agent` over WebSocket | on | Reply = nonce; the trace file was written by the gateway process. |
| 8–9 | gateway, `/reset` then a new turn | on | After the reset the agent still names `P1 Prove the hook`. |
| 10 | `agent --local` with `config/context.patch.json5` applied to the spike profile | on | Session records `contextTokens: 250000`; `CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000` is in the `claude -p` process env. |
| c1–c4 | gateway, window lowered to 100k, four ~25k-token messages | on | Claude Code compacted inside its own session (prompt 112k → 91k → 102k → 91k, same Claude session id); every turn replied. |
| k2 | gateway, after those compactions | on | The agent names P1 and its done-when. |
| k3 | gateway, `--model claude-cli/claude-opus-5` | on | Works with the new `claude-cli` provider entry. |
| k4 | `openclaw sessions compact` (what `/compact` runs) | on | Fails: OpenClaw's summariser presents Claude Code 2.1.75, which the API refuses for Opus 5.5. |

## Where the text goes

The CLI backend's prepare step calls the prompt-build hooks and prepends `prependContext` to the user turn. The plugin uses `prependContext`, not `appendSystemContext`: the system prompt is part of the claude live-session fingerprint, so text that changes every turn (the gauge) would restart the Claude process and lose the prompt cache on every message.

Cost: the block (about 250–300 tokens with an active problem, about 100 without) stays in the transcript each turn, so roughly 28k over 100 turns. Compaction and the daily reset clear it. Session-history search will also index it, which adds boilerplate to recall results.

## Gotcha

Shells spawned by the live gateway inherit `OPENCLAW_GATEWAY_PORT=18789`, which overrides a profile's port. Unset it when testing against another gateway.
