# Replay

The replay runs one reply at a decision point twice — once with the plugin's
reminder and skills, once without — and scores both blind against the same
rubric the weekly review uses (`../scorer/`).

Cases are built from real conversations, so they and the transcripts behind them
live in the overlay, never here (R31). The core holds the harness, the scorer
and the rubric.

```
APS_MODEL=claude-opus-5-5 python3 run.py <overlay>/replay/cases <out> --split tuning
```

## Splits

Every case carries `split`. Wording is tuned against the `tuning` split only,
and a score is quoted from the `held-out` split, so the figure is not measured
on the cases it was tuned on (R38). A case's split is decided once, at random,
when the case is written, and recorded then.

## Building cases

Cutting a case out of a real conversation is operator-specific work: it needs
the chat history, the transcripts and the register as it stood at that moment.
That builder belongs in the overlay. It writes, per case:

- `<id>.history.txt` — the thread up to the decision point
- `<id>.next.txt` — the message that triggers it
- an entry in `cases.json` with `kind`, `expect`, `register` and `split`

Seed each case's register with the problem **as it stood before the person
reframed it**. A register that already holds the reframed problem measures
nothing.
