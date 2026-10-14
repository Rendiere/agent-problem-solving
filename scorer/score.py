#!/usr/bin/env python3
"""One scorer, used by the replay at build time and by the weekly review.

Both import this module, so a score means the same thing in both places
(R35, KTD12). The judge prompt and the rubric are files beside this one; they
quote none of the reminder's wording, so the judge cannot tell the two arms of a
replay apart by vocabulary.
"""
import json
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
RUBRIC = (HERE / "rubric.md").read_text()
JUDGE = (HERE / "judge.md").read_text()

SYSTEM = "You are a strict, fair evaluator. Output JSON only."
MAX_TAIL = 2500


def prompt_for(kind, problem, expect, tail, nxt, reply):
    """The judge prompt for one decision point."""
    return JUDGE.format(
        kind=kind,
        problem=problem,
        expect=expect,
        tail=tail[-MAX_TAIL:],
        nxt=nxt,
        reply=reply,
        rubric=RUBRIC,
    )


def call_model(system, prompt, model, timeout=600, cwd=None):
    """Ask the model, with no tools and no inherited settings."""
    r = subprocess.run(
        [
            "claude", "-p", "--model", model,
            "--tools", "",
            "--setting-sources", "project",
            "--strict-mcp-config",
            "--system-prompt", system,
            "--output-format", "text",
        ],
        input=prompt, capture_output=True, text=True, timeout=timeout, cwd=cwd,
    )
    if r.returncode:
        raise RuntimeError(r.stderr[-500:])
    return r.stdout.strip()


def parse(out):
    """Pull the JSON verdict out of whatever the judge returned."""
    start, end = out.find("{"), out.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"no JSON in the judge's answer: {out[:200]!r}")
    v = json.loads(out[start:end + 1])
    if v.get("score") not in (0, 1, 2):
        raise ValueError(f"score must be 0, 1 or 2, got {v.get('score')!r}")
    v["friction"] = bool(v.get("friction"))
    v["why"] = str(v.get("why", ""))
    return v


def score(kind, problem, expect, tail, nxt, reply, model, cwd=None):
    """Score one reply. Returns {"score": 0|1|2, "friction": bool, "why": str}."""
    return parse(call_model(SYSTEM, prompt_for(kind, problem, expect, tail, nxt, reply), model, cwd=cwd))
