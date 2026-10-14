#!/usr/bin/env node
// aps — the one command that changes a problem's status.
//
// It validates the change, stamps the date, applies the side-task pause and
// resume rule, writes the decision log and advances the agent's snapshot, all
// under one lock (KTD5, KTD6). It needs no gateway and no plugin, so layer 1 of
// the method works on any runtime that can run a command.
//
//   aps set P4 status=active confirmed=2026-10-14
//   aps add "Send the first ten notes" problem="…" done-when="…" thread=topic:42
//   aps lint
//   aps report [--json]
//   aps doctor

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseRegister, lintRegister, STATUSES, PENDING_KINDS } from "../lib/register.js";
import { setFields, setTitle, addProblem, nextId } from "../lib/edit.js";
import {
  appendLog, diffRegister, readCounts, readLog, readSnapshot, readTurnMarker, snapshotOf, withLock, writeSnapshot, today,
} from "../lib/ledger.js";
import { DEFAULT_REGISTER_FILE, LOG_FILE } from "../lib/store.js";

const USAGE = `aps — problem register and decision log

  aps set <P<n>> <field>=<value> …   change a status or a field
  aps add "<action title>" <field>=<value> …   draft a new proposed entry
  aps lint [--agent <id>]            check one register, or every one
  aps report [--json]                parked, stale, pending, session sizes
  aps doctor                         is the install sound?

  --overlay <path>   overlay root (default: $APS_OVERLAY)
  --agent <id>       agent id (default: $APS_AGENT)
`;

function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json" || a === "--help" || a === "-h") flags[a.replace(/^-+/, "")] = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function pairs(args) {
  const out = {};
  for (const a of args) {
    const i = a.indexOf("=");
    if (i < 1) throw new Error(`expected field=value, got '${a}'`);
    out[a.slice(0, i).trim().toLowerCase().replace(/[-_]+/g, " ")] = a.slice(i + 1);
  }
  return out;
}

function die(msg, code = 1) {
  process.stderr.write(`aps: ${msg}\n`);
  process.exit(code);
}

const cfgFrom = (flags) => ({
  overlayPath: flags.overlay ?? process.env.APS_OVERLAY ?? "",
  registerFile: process.env.APS_REGISTER_FILE ?? DEFAULT_REGISTER_FILE,
});

function resolveOverlay(flags) {
  const root = cfgFrom(flags).overlayPath;
  if (!root) die("no overlay. Pass --overlay <path> or set APS_OVERLAY.");
  return path.resolve(root);
}

const stateDirOf = (overlay) => process.env.APS_STATE_DIR ?? path.join(overlay, ".state");
const agentDirOf = (overlay, agent) => path.join(overlay, "agents", agent);
const registerOf = (overlay, agent, flags) => path.join(agentDirOf(overlay, agent), cfgFrom(flags).registerFile);
const logOf = (overlay, agent) => path.join(agentDirOf(overlay, agent), LOG_FILE);

function resolveAgent(flags) {
  const a = flags.agent ?? process.env.APS_AGENT ?? "";
  if (!a) die("no agent. Pass --agent <id> or set APS_AGENT.");
  return a;
}

async function listAgents(overlay) {
  try {
    const entries = await readdir(path.join(overlay, "agents"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

const daysSince = (date) => {
  const t = Date.parse(date ?? "");
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
};

// ------------------------------------------------------------------ set

/** Everything `aps set` refuses, checked against the register as it will be. */
function validate(before, after, id, changes) {
  const p = after.problems.find((x) => x.id === id);
  if (!p) throw new Error(`${id} is not in the register`);
  if (changes.status !== undefined) {
    if (!STATUSES.includes(p.status)) {
      throw new Error(`unknown status '${changes.status}'. Use one of: ${STATUSES.join(", ")}`);
    }
  }
  if (changes.pending !== undefined && p.pending && !PENDING_KINDS.includes(p.pending.kind)) {
    throw new Error(`unknown pending kind '${p.pending.kind}'. Use one of: ${PENDING_KINDS.join(", ")}`);
  }
  const open = !["done", "dropped"].includes(p.status);
  if (open && !p.thread) throw new Error(`${id} has no thread. Set thread=<thread> in the same call.`);

  const beforeFindings = new Set(lintRegister(before).map((f) => `${f.code}|${f.problem ?? ""}|${f.message}`));
  const newFindings = lintRegister(after).filter(
    (f) => !beforeFindings.has(`${f.code}|${f.problem ?? ""}|${f.message}`),
  );
  if (newFindings.length) {
    throw new Error(newFindings.map((f) => f.message).join("; "));
  }
  return p;
}

/**
 * The side-task rule, both ways (R9): a side task going active pauses its
 * parent, and a side task leaving active resumes it.
 */
function sideTaskMoves(before, after, id) {
  const now = after.problems.find((x) => x.id === id);
  const was = before.problems.find((x) => x.id === id);
  if (!now?.parent) return [];
  const parent = after.problems.find((x) => x.id === now.parent);
  if (!parent) return [];
  const becameActive = now.status === "active" && was?.status !== "active";
  const leftActive = was?.status === "active" && now.status !== "active";
  if (becameActive && parent.status === "active") return [[parent.id, { status: "paused", updated: today() }]];
  if (leftActive && parent.status === "paused") return [[parent.id, { status: "active", updated: today() }]];
  return [];
}

async function cmdSet({ flags, rest }) {
  const overlay = resolveOverlay(flags);
  const agent = resolveAgent(flags);
  const [id, ...args] = rest;
  if (!/^P\d+$/.test(id ?? "")) die("first argument must be a problem id, e.g. P4");
  const changes = pairs(args);
  if (!Object.keys(changes).length) die("nothing to set");

  const file = registerOf(overlay, agent, flags);
  const stateDir = stateDirOf(overlay);

  await withLock(stateDir, agent, async () => {
    const text = await readFile(file, "utf8");
    const before = parseRegister(text);
    const title = changes.title;
    delete changes.title;
    if (changes.status !== undefined) changes.updated = changes.updated ?? today();

    let next = setFields(text, id, changes);
    if (title !== undefined) next = setTitle(next, id, title);

    // The side-task rule runs before the checks: a side task going active is
    // allowed to take the thread's slot precisely because its parent pauses in
    // the same move (R9), so the final state is what gets validated.
    for (const [pid, fields] of sideTaskMoves(before, parseRegister(next), id)) {
      next = setFields(next, pid, fields);
    }
    const after = parseRegister(next);
    validate(before, after, id, changes);

    const problems = lintRegister(after).filter((e) => e.problem === id);
    if (problems.length) throw new Error(problems.map((e) => e.message).join("; "));

    await writeFile(file, next, "utf8");
    const baseline = (await readSnapshot(stateDir, agent)) ?? snapshotOf(before);
    const actor = (await readTurnMarker(stateDir, agent))?.actor ?? "person";
    const entries = diffRegister(baseline, after, { actor });
    await appendLog(logOf(overlay, agent), entries, { agent, source: "aps set", actor });
    await writeSnapshot(stateDir, agent, snapshotOf(after));
    process.stdout.write(
      `${id} ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(" ")}\n` +
        entries.map((e) => `  logged ${e.kind}${e.flag ? ` (flagged: ${e.flag})` : ""} on ${e.problem}`).join("\n") +
        (entries.length ? "\n" : ""),
    );
  }).catch((err) => die(err.message));
}

async function cmdAdd({ flags, rest }) {
  const overlay = resolveOverlay(flags);
  const agent = resolveAgent(flags);
  const [title, ...args] = rest;
  if (!title) die('first argument must be the action title, e.g. "Win the first ten artists"');
  const fields = pairs(args);
  const file = registerOf(overlay, agent, flags);
  const stateDir = stateDirOf(overlay);

  await withLock(stateDir, agent, async () => {
    const text = await readFile(file, "utf8");
    const id = nextId(parseRegister(text));
    const before = parseRegister(text);
    const next = addProblem(text, id, title, { status: "proposed", updated: today(), ...fields });
    const after = parseRegister(next);
    const bad = lintRegister(after).filter((e) => e.problem === id);
    if (bad.length) throw new Error(bad.map((e) => e.message).join("; "));
    await writeFile(file, next, "utf8");
    const actor = (await readTurnMarker(stateDir, agent))?.actor ?? "person";
    const entries = diffRegister((await readSnapshot(stateDir, agent)) ?? snapshotOf(before), after, { actor });
    await appendLog(logOf(overlay, agent), entries, { agent, source: "aps add", actor });
    await writeSnapshot(stateDir, agent, snapshotOf(after));
    process.stdout.write(`${id} ${title}\n`);
  }).catch((err) => die(err.message));
}

// ----------------------------------------------------------------- lint

async function lintOne(overlay, agent, flags) {
  const file = registerOf(overlay, agent, flags);
  try {
    const register = parseRegister(await readFile(file, "utf8"));
    return { agent, file, findings: lintRegister(register), register };
  } catch (err) {
    return { agent, file, findings: [{ code: "unreadable", message: `cannot read ${file}: ${err.message}`, problem: null }] };
  }
}

async function cmdLint({ flags }) {
  const overlay = resolveOverlay(flags);
  const agents = flags.agent ? [flags.agent] : await listAgents(overlay);
  if (!agents.length) die(`no agents under ${path.join(overlay, "agents")}`);
  let bad = 0;
  for (const agent of agents) {
    const r = await lintOne(overlay, agent, flags);
    if (!r.findings.length) {
      process.stdout.write(`${agent}: clean\n`);
      continue;
    }
    bad += r.findings.length;
    process.stdout.write(`${agent}: ${r.findings.length} finding(s)\n`);
    for (const f of r.findings) process.stdout.write(`  ${f.code}: ${f.message}\n`);
  }
  process.exit(bad ? 1 : 0);
}

// --------------------------------------------------------------- report

const STALE_DAYS = 7;
const PENDING_HOURS = 24;
const PROPOSED_DAYS = 3;

async function buildReport(overlay, flags) {
  const stateDir = stateDirOf(overlay);
  const agents = flags.agent ? [flags.agent] : await listAgents(overlay);
  const out = { at: new Date().toISOString(), overlay, agents: [] };
  for (const agent of agents) {
    const { register, findings, file } = await lintOne(overlay, agent, flags);
    const row = {
      agent,
      register: file,
      mission: register?.mission ?? "",
      lint: findings.map((f) => f.message),
      parked: [],
      stale: [],
      pending: [],
      proposed: [],
      blocked: [],
      turns: {},
    };
    for (const p of register?.problems ?? []) {
      const age = daysSince(p.fields.updated);
      const brief = { id: p.id, title: p.title, thread: p.thread, days: age, state: p.fields.state ?? "" };
      if (p.status === "parked") row.parked.push(brief);
      if (p.status === "blocked") row.blocked.push(brief);
      if (p.status === "active" && age !== null && age >= STALE_DAYS) row.stale.push(brief);
      if (p.status === "proposed" && age !== null && age >= PROPOSED_DAYS) row.proposed.push(brief);
      if (p.pending) {
        const pAge = daysSince(p.pending.date);
        if (pAge === null || pAge * 24 >= PENDING_HOURS) {
          row.pending.push({ ...brief, kind: p.pending.kind, asked: p.pending.date });
        }
      }
    }
    const counts = await readCounts(stateDir, agent);
    const day = today();
    const t = counts[day] ?? { turns: 0, person: 0, warn: 0, high: 0 };
    row.turns = {
      day,
      ...t,
      aboveWarnShare: t.turns ? Math.round(((t.warn + t.high) / t.turns) * 100) : 0,
    };
    row.largestSession = await largestSession(stateDir, agent);
    out.agents.push(row);
  }
  return out;
}

/** The biggest live session the gauge has seen for this agent. */
async function largestSession(stateDir, agent) {
  try {
    const file = path.join(stateDir, `${agent}.sessions.json`);
    const data = JSON.parse(await readFile(file, "utf8"));
    const rows = Object.entries(data).map(([key, v]) => ({ key, ...v }));
    rows.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function renderReport(r) {
  const L = [`Problem report — ${r.at.slice(0, 16).replace("T", " ")} UTC`];
  if (!r.agents.length) L.push("No agents found in the overlay.");
  for (const a of r.agents) {
    L.push("", `## ${a.agent}`);
    if (a.mission) L.push(`Mission: ${a.mission}`);
    const list = (name, rows, fmt) =>
      rows.length ? L.push(`${name}:`, ...rows.map((x) => `  - ${fmt(x)}`)) : null;
    list("Parked", a.parked, (x) => `${x.id} ${x.title} (${x.thread}, ${x.days ?? "?"}d) ${x.state}`);
    list("Blocked", a.blocked, (x) => `${x.id} ${x.title} (${x.thread}) ${x.state}`);
    list(`Active, untouched ${STALE_DAYS}+ days`, a.stale, (x) => `${x.id} ${x.title} (${x.days}d)`);
    list("Waiting on an answer", a.pending, (x) => `${x.id} ${x.title} — ${x.kind} asked ${x.asked || "date unknown"}`);
    list(`Proposed ${PROPOSED_DAYS}+ days`, a.proposed, (x) => `${x.id} ${x.title} (${x.days}d)`);
    if (a.largestSession) L.push(`Largest live session: ${a.largestSession.key} at ${Math.round((a.largestSession.tokens ?? 0) / 1000)}k tokens`);
    L.push(`Turns today: ${a.turns.turns} (${a.turns.person} from the person), ${a.turns.aboveWarnShare}% above the warning level`);
    if (a.lint.length) L.push("Register problems:", ...a.lint.map((m) => `  ! ${m}`));
    if (!a.parked.length && !a.stale.length && !a.pending.length && !a.proposed.length && !a.blocked.length && !a.lint.length) {
      L.push("Nothing needs attention.");
    }
  }
  return L.join("\n");
}

async function cmdReport({ flags }) {
  const overlay = resolveOverlay(flags);
  const r = await buildReport(overlay, flags);
  process.stdout.write(flags.json ? `${JSON.stringify(r, null, 1)}\n` : `${renderReport(r)}\n`);
}

// --------------------------------------------------------------- doctor

async function cmdDoctor({ flags }) {
  const overlay = resolveOverlay(flags);
  const agents = flags.agent ? [flags.agent] : await listAgents(overlay);
  const checks = [];
  const ok = (name, pass, note = "") => checks.push({ name, pass, note });

  ok("overlay found", await stat(overlay).then(() => true, () => false), overlay);
  ok(
    "deny-list present",
    await stat(path.join(overlay, "denylist.txt")).then(() => true, () => false),
    path.join(overlay, "denylist.txt"),
  );
  const hook = path.join(overlay, "..", ".git", "hooks", "pre-commit");
  ok("deny-list pre-commit hook installed", await stat(hook).then(() => true, () => false), hook);
  ok("at least one agent", agents.length > 0, agents.join(", "));

  for (const agent of agents) {
    const r = await lintOne(overlay, agent, flags);
    ok(`${agent}: register readable`, Boolean(r.register), r.file);
    ok(`${agent}: register lint clean`, r.findings.length === 0, r.findings.map((f) => f.code).join(", "));
    ok(`${agent}: mission line set`, Boolean(r.register?.mission), r.register?.mission ?? "");
    // A dry hook call: the reminder must come back non-empty for a real thread.
    try {
      const { buildInjection } = await import("../lib/inject.js");
      const thread = r.register?.problems.find((p) => p.thread)?.thread ?? "any";
      const text = buildInjection({ register: r.register }, { thread, reading: 10_000 });
      ok(`${agent}: reminder builds`, text.length > 40, `${text.length} chars for ${thread}`);
    } catch (err) {
      ok(`${agent}: reminder builds`, false, err.message);
    }
    const lines = await readLog(logOf(overlay, agent));
    ok(`${agent}: decision log reachable`, true, `${lines.length} line(s)`);
  }

  for (const c of checks) {
    process.stdout.write(`${(c.pass ? "ok" : "FAIL").padEnd(4)} ${c.name}${c.note ? ` — ${c.note}` : ""}\n`);
  }
  process.exit(checks.some((c) => !c.pass) ? 1 : 0);
}

// ----------------------------------------------------------------- main

const [, , rawCmd, ...argv] = process.argv;
const cmd = rawCmd && !rawCmd.startsWith("-") ? rawCmd : "";
const parsed = parseArgv(cmd ? argv : process.argv.slice(2));
if (!cmd || parsed.flags.help || parsed.flags.h || cmd === "help") {
  process.stdout.write(USAGE);
  process.exit(cmd && cmd !== "help" && !parsed.flags.help && !parsed.flags.h ? 1 : 0);
}
const commands = { set: cmdSet, add: cmdAdd, lint: cmdLint, report: cmdReport, doctor: cmdDoctor };
const fn = commands[cmd];
if (!fn) die(`unknown command '${cmd}'.\n${USAGE}`);
await fn(parsed).catch((err) => die(err?.message ?? String(err)));
