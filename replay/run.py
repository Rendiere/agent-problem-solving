#!/usr/bin/env python3
"""Replay decision points with and without the plugin, then score blind.

    run.py <cases_dir> <out_dir> [--split tuning|held-out|all] [case_id ...]

<cases_dir> lives in the overlay. It holds cases.json plus one
<case>.history.txt and <case>.next.txt per case, built from real
conversations — which is why raw chat text never enters the core (R31).

cases.json:
  {
    "operator": {
      "person": "the person's name as the transcripts write it",
      "agents": {"<agent id>": {"name": "...", "soul": "/path/to/SOUL.md"}}
    },
    "cases": [
      {"id": "...", "agent": "...", "topic": "...", "split": "tuning",
       "kind": "deliberate switch", "expect": "...", "register": "...",
       "carries_to": "<later case id>"}
    ]
  }

Each case's register is seeded with the problem as it stood *before* the person
reframed it, so the replay measures whether the agent notices, not whether it
can read the answer off the register.
"""
import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
CORE = HERE.parent
sys.path.insert(0, str(CORE / "scorer"))
import score as scorer  # noqa: E402

MODEL = os.environ.get("APS_MODEL", "claude-opus-5-5")
# An empty working directory with project-only settings, so no user memory,
# instructions file or MCP server reaches either arm.
SCRATCH = os.environ.get("APS_REPLAY_CWD", "/tmp/aps-replay-ws")


def injection(register_text, thread):
    """The block the hook would prepend, built by the real code."""
    js = f"""
import {{ parseRegister }} from '{CORE}/lib/register.js';
import {{ buildInjection }} from '{CORE}/lib/inject.js';
const r = parseRegister(process.argv[1]);
process.stdout.write(buildInjection({{ register: r }}, {{ thread: {json.dumps(thread)}, reading: 120000 }}));
"""
    return subprocess.check_output(["node", "--input-type=module", "-e", js, register_text]).decode()


def skills_list():
    out = []
    for p in sorted((CORE / "skills").glob("*/SKILL.md")):
        head = p.read_text().split("---")[1]
        name = next(l for l in head.splitlines() if l.startswith("name:")).split(":", 1)[1].strip()
        desc = next(l for l in head.splitlines() if l.startswith("description:")).split(":", 1)[1].strip()
        out.append(f"- {name}: {desc} (file: {p})")
    return "\n".join(out)


def system_prompt(case, arm, operator):
    agent = operator["agents"][case["agent"]]
    soul = pathlib.Path(agent["soul"]).read_text()
    person = operator["person"]
    s = (
        f"{soul}\n\n# Runtime\nYou are {agent['name']}, replying in a chat thread with {person}. "
        "You have no tools in this session. Write only your next message (short, as you normally would). "
        "Say what you would do; do not pretend tool results."
    )
    if arm == "with":
        s += (
            "\n\n# Skills available (from the agent-problem-solving plugin)\n"
            + skills_list()
            + "\nYour problem register is injected at the top of every turn."
        )
    return s


def user_prompt(case, arm, history, nxt, person):
    # Live, the hook prepends the block to the newest turn, so it sits directly
    # before the person's message.
    block = injection(case["register"], case.get("thread") or f"topic:{case['topic']}") + "\n\n" if arm == "with" else ""
    return f"Conversation so far in this thread (oldest first):\n\n{history}\n\n---\n{block}{person}'s new message:\n{nxt}"


def resolve(cases):
    """Fill in registers inherited from an earlier case, so a side-task entry one
    case writes is visible to the next (the fan-out pair)."""
    by_id = {c["id"]: c for c in cases}
    for c in cases:
        if "register_from" in c:
            c["register"] = by_id[c["register_from"]]["register"]
        c.setdefault("split", "tuning")
    return by_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cases_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--split", default="all", choices=["tuning", "held-out", "all"])
    ap.add_argument("--arms", default="without,with")
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()

    cases_dir, out = pathlib.Path(a.cases_dir), pathlib.Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    os.makedirs(SCRATCH, exist_ok=True)
    spec = json.loads((cases_dir / "cases.json").read_text())
    operator, cases = spec["operator"], spec["cases"]
    by_id = resolve(cases)

    chosen = [c for c in cases if a.split in ("all", c["split"])]
    if a.ids:
        chosen = [by_id[i] for i in a.ids]
    arms = a.arms.split(",")
    jobs = [(c, arm) for c in chosen for arm in arms]

    def run(job):
        case, arm = job
        history = (cases_dir / f"{case['id']}.history.txt").read_text()
        nxt = (cases_dir / f"{case['id']}.next.txt").read_text()
        reply = scorer.call_model(
            system_prompt(case, arm, operator),
            user_prompt(case, arm, history, nxt, operator["person"]),
            MODEL, cwd=SCRATCH,
        )
        problem = next((l for l in case["register"].splitlines() if l.startswith("## P")), "")
        verdict = scorer.score(case["kind"], problem, case["expect"], history, nxt, reply, MODEL, cwd=SCRATCH)
        rec = {"case": case["id"], "split": case["split"], "arm": arm, "reply": reply, **verdict}
        (out / f"{case['id']}.{arm}.json").write_text(json.dumps(rec, indent=1, ensure_ascii=False))
        return rec

    with cf.ThreadPoolExecutor(max_workers=int(os.environ.get("APS_PAR", "4"))) as ex:
        results = list(ex.map(run, jobs))

    results.sort(key=lambda r: (r["split"], r["case"], r["arm"]))
    for r in results:
        print(f"{r['split']:9} {r['case']:26} {r['arm']:8} score={r['score']} friction={r['friction']}  {r['why']}")
    for split in sorted({r["split"] for r in results}):
        for arm in arms:
            rows = [r for r in results if r["split"] == split and r["arm"] == arm]
            if rows:
                print(f"\n{split} / {arm}: {sum(r['score'] for r in rows)} of {2 * len(rows)} over {len(rows)} case(s)")
    (out / "summary.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
