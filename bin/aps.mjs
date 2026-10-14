#!/usr/bin/env node
// aps — the layer-1 command. Changes a problem's status, lints a register and
// prints the report. It works with no plugin and no gateway: a register, this
// command and the method skill are enough to run the method by hand.
//
//   aps set P2 status=parked state="waiting on the clinic" [--confirmed]
//   aps lint [--agent <id> | --all]
//   aps report [--agents <id>,<id>] [--json] [--stale-days 7] [--hours 24]
//
// The overlay comes from --overlay or APS_OVERLAY; the agent from --agent,
// APS_AGENT, or the overlay when it holds exactly one agent.

import { readFile, writeFile, readdir, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseRegister, lintRegister, threadsOverlap, STATUSES } from "../lib/register.js";
import { setFields } from "../lib/edit.js";
import { today } from "../lib/gauge.js";
import { registerPath, ledgerPath, snapshotPath, turnsPath, turnPath, turnDir, agentIdError, DEFAULT_REGISTER_FILE } from "../lib/paths.js";
import {
  snapshotOf,
  diffSnapshots,
  readSnapshot,
  writeSnapshot,
  appendLedger,
  readLedger,
  readTurns,
  readTurnMarker,
  readNewestTurnMarker,
  actorFromMarker,
  withLock,
  flagFor,
  stamp,
  BUSY,
} from "../lib/ledger.js";
import { sessionSizes } from "../adapters/openclaw/sessions.js";
import { threadForCli } from "../adapters/cli/runtime.js";
import {
  installClaudeCode, installCodex, installOpenClaw, installAgentsMd, writeSettings, installStatus,
  claudeConfigDir, codexHome, openclawConfigFile, agentsSkillsDir, skillNames,
  prepareOverlay, settleCore, stableHome, installBin,
  overlayChoices, pickOverlay, openclawDefaultAgent, cliAgentFor,
} from "../lib/install.js";
import { settingsDir, runtimeConfig, readSettings } from "../lib/settings.js";
import { packageRoot } from "../lib/self.js";
import { existsSync } from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline/promises";

const argv = process.argv.slice(2);

// Thrown inside a locked section so the lock is released before the process
// exits; process.exit() would skip the release and stall the next writer.
class UserError extends Error {}

function die(message, code = 2) {
  console.error(`aps: ${message}`);
  process.exit(code);
}

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) die(`--${name} needs a value`);
  return value;
}

const has = (name) => argv.includes(`--${name}`);

// Flags that stand alone. Anything else spelled --x takes the next token as its
// value, so a positional argument is never confused with one.
const SWITCHES = new Set(["dry-run", "status", "json", "all", "help", "confirmed", "clear-pending", "all-projects", "yes"]);

/** The arguments that are not flags and not a flag's value. */
function positional(from = 0) {
  const out = [];
  for (let i = from; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }
    if (!SWITCHES.has(a.slice(2))) i += 1;
  }
  return out;
}
const config = () => runtimeConfig();
const day = () => today(new Date(), flag("tz") ?? config().timeZone ?? undefined);

function overlayDir() {
  const dir = flag("overlay") ?? config().overlayPath;
  if (!dir) die("no overlay: pass --overlay <path> or set APS_OVERLAY");
  if (!path.isAbsolute(dir)) die(`the overlay path must be absolute, not "${dir}"`);
  return path.resolve(dir);
}

async function agentsIn(overlay) {
  try {
    const entries = await readdir(path.join(overlay, "agents"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function oneAgent(overlay) {
  const named = flag("agent") ?? config().agentId;
  if (named) {
    const bad = agentIdError(named);
    if (bad) die(bad);
    return named;
  }
  const all = await agentsIn(overlay);
  if (all.length === 1) return all[0];
  die(`pass --agent: the overlay holds ${all.length} agents (${all.join(", ") || "none"})`);
}

const registerFile = () => flag("register") ?? config().registerFile ?? DEFAULT_REGISTER_FILE;

const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

const daysAgo = (iso, from = new Date()) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : Math.floor((from.getTime() - t) / 86_400_000);
};

// ---------------------------------------------------------------- aps set

function parseAssignments(args) {
  const fields = {};
  for (const arg of args) {
    if (arg.startsWith("--")) break;
    const m = arg.match(/^([a-zA-Z][\w -]*)=(.*)$/s);
    if (!m) die(`"${arg}" is not field=value`);
    const key = m[1].toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!key) die(`"${arg}" has no field name`);
    if (fields[key] !== undefined) die(`${key} given twice`);
    fields[key] = m[2];
  }
  return fields;
}

/** Lint errors in `after` that `before` did not already have. */
function newErrors(before, after) {
  const had = new Set(before.filter((f) => f.level === "error").map((f) => `${f.code}:${f.id ?? ""}`));
  return after.filter((f) => f.level === "error" && !had.has(`${f.code}:${f.id ?? ""}`));
}

async function cmdSet() {
  const words = positional(0);
  const id = words[1];
  if (!id) die("usage: aps set <ID> field=value [field=value…]");
  const fields = parseAssignments(words.slice(2));
  if (!Object.keys(fields).length) die("nothing to set");

  const overlay = overlayDir();
  const agent = await oneAgent(overlay);
  const file = registerPath(overlay, agent, registerFile());
  const snapFile = snapshotPath(overlay, agent);
  if (!(await exists(file))) die(`no register at ${file}`);
  const stampDay = day();
  const markerThread = flag("thread") ?? threadForCli(process.cwd());
  const markerSession = flag("session") ?? null;
  const marker = markerSession
    ? await readTurnMarker(turnPath(overlay, agent, markerThread, markerSession))
    : await readNewestTurnMarker(turnDir(overlay, agent, markerThread));
  const actor = actorFromMarker(marker);

  let result;
  try {
    result = await withLock(`${snapFile}.lock`, async () => {
      const before = await readFile(file, "utf8");
      const reg = parseRegister(before);
      const want = id.toUpperCase();
      const matches = reg.problems.filter((p) => p.id === want);
      if (!matches.length) throw new UserError(`${id} is not in ${file}`);
      // Which of the two is meant is a guess, and a guess here edits the wrong
      // problem: say so and let the operator merge them.
      if (matches.length > 1) throw new UserError(`${want} appears twice in ${file}. Give each entry its own id first.`);
      const target = matches[0];

      const wantStatus = fields.status?.toLowerCase();
      if (wantStatus !== undefined && !STATUSES.includes(wantStatus)) {
        throw new UserError(`unknown status "${fields.status}". Use one of: ${STATUSES.join(", ")}`);
      }
      const status = wantStatus ?? target.status;
      const thread = String(fields.thread ?? target.thread ?? "").trim();
      const parentId = (fields.parent ?? target.parent ?? "").toUpperCase();
      const alsoSet = [];

      // The one-per-thread rule is checked on the result of this call, not on
      // whether the call happens to mention status: moving an already-active
      // entry into an occupied thread is the same collision (R3).
      if (["active", "blocked"].includes(status)) {
        if (!thread) throw new UserError(`${id} has no thread, so it cannot be ${status}. Set thread=<id> in the same call.`);
        // Overlap, not string equality: a holder may name several threads, or
        // "any", which holds every thread's slot (R3).
        const holders = reg.problems.filter(
          (p) => p.id !== target.id && ["active", "blocked"].includes(p.status) && threadsOverlap(p, { thread }),
        );
        const parentHolder = holders.find((p) => p.id === parentId);
        if (holders.length && !parentHolder) {
          throw new UserError(
            `${thread} already holds ${holders.map((p) => `${p.id} (${p.status})`).join(", ")}. Park or unblock it first, or set parent=<ID> to make ${id} its side task.`,
          );
        }
        // The side-task rule: the child takes the thread, the parent waits (R9).
        if (parentHolder) alsoSet.push([parentHolder.id, { status: "paused", updated: stampDay }]);
      }

      if (["done", "dropped"].includes(status) && parentId) {
        const parent = reg.problems.find((p) => p.id === parentId);
        // Closing a side task hands the thread back to its parent (R9). The
        // operator's yes to the close covers the resume, so it is confirmed too.
        if (parent?.status === "paused") {
          alsoSet.push([parent.id, { status: "active", updated: stampDay, ...(has("confirmed") ? { confirmed: `${stampDay} resumed` } : {}) }]);
        }
      }

      const patch = { ...fields, updated: stampDay };
      if (has("confirmed")) patch.confirmed = `${stampDay}${wantStatus ? ` ${wantStatus}` : ""}`;
      if (has("clear-pending")) patch.pending = null;

      let text = setFields(before, target.id, patch);
      for (const [otherId, otherPatch] of alsoSet) text = setFields(text, otherId, otherPatch);

      // The checks above cover the collisions this call can see coming. Linting
      // the result catches the rest: whatever rule this patch would newly break
      // is refused, while a register that was already failing a rule elsewhere
      // can still be edited.
      const broke = newErrors(lintRegister(reg), lintRegister(parseRegister(text)));
      if (broke.length) {
        throw new UserError(`this change would break the register:\n  ${broke.map((f) => `${f.id ? `${f.id} — ` : ""}${f.message}`).join("\n  ")}`);
      }
      await writeAtomic(file, text);

      // Log what this call changed as "aps", and anything changed by hand since
      // the hook last looked as "hand-edit", then advance the snapshot past both.
      const onDisk = await readSnapshot(snapFile);
      const beforeSnap = snapshotOf(reg);
      const afterSnap = snapshotOf(parseRegister(text));
      const lastPersonTurn = (await readTurns(turnsPath(overlay, agent))).lastPersonTurn ?? null;
      const rows = [];
      const push = (e, source) => rows.push(stamp({ ...e, flag: flagFor(e, { actor, day: stampDay, lastPersonTurn }) }, { agent, actor, source, day: stampDay }));
      if (onDisk) for (const e of diffSnapshots(onDisk, beforeSnap)) push(e, "hand-edit");
      for (const e of diffSnapshots(beforeSnap, afterSnap)) push(e, "aps");
      await appendLedger(ledgerPath(overlay, agent), rows);
      await writeSnapshot(snapFile, afterSnap);
      return rows;
    });
  } catch (err) {
    if (err instanceof UserError) die(err.message);
    throw err;
  }
  if (result === BUSY) die("another aps set or hook run holds the lock; try again");

  if (has("json")) {
    console.log(JSON.stringify({ agent, id: id.toUpperCase(), actor, logged: result }, null, 2));
    return;
  }
  for (const e of result) console.log(`${e.problem} ${e.kind}${e.outcome ? ` (${e.outcome})` : ""}${e.flag ? ` — flagged: ${e.flag}` : ""}`);
  if (!result.length) console.log("fields updated; no status or question changed");
}

// --------------------------------------------------------------- aps lint

async function lintOne(overlay, agent) {
  const file = registerPath(overlay, agent, registerFile());
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return { agent, file, findings: [{ level: "error", code: "unreadable", id: null, message: err.message }] };
  }
  return { agent, file, findings: lintRegister(parseRegister(text)) };
}

async function cmdLint() {
  const overlay = overlayDir();
  let agents;
  if (has("all")) {
    agents = [];
    // An agent folder with no register has not been rolled out yet; that is not
    // a lint failure.
    for (const agent of await agentsIn(overlay)) {
      if (await exists(registerPath(overlay, agent, registerFile()))) agents.push(agent);
    }
  } else {
    agents = [await oneAgent(overlay)];
  }
  const results = [];
  for (const agent of agents) results.push(await lintOne(overlay, agent));
  const errors = results.flatMap((r) => r.findings.filter((f) => f.level === "error"));
  if (has("json")) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    if (!results.length) console.log(`No register under ${path.join(overlay, "agents")} yet.`);
    for (const r of results) {
      console.log(`${r.agent} (${r.file})`);
      if (!r.findings.length) console.log("  clean");
      for (const f of r.findings) console.log(`  ${f.level}: ${f.id ? `${f.id} — ` : ""}${f.message}`);
    }
  }
  process.exit(errors.length ? 1 : 0);
}

// ------------------------------------------------------------- aps report

async function reportOne(overlay, agent, { staleDays, hours }) {
  const file = registerPath(overlay, agent, registerFile());
  let register = null;
  let notice = null;
  try {
    register = parseRegister(await readFile(file, "utf8"));
  } catch (err) {
    notice = err?.code === "ENOENT" ? `no register at ${file}` : err.message;
  }
  const problems = register?.problems ?? [];
  const parked = problems
    .filter((p) => p.status === "parked")
    .map((p) => ({ id: p.id, title: p.title, thread: p.thread, days: daysAgo(p.updated), state: p.fields.state ?? "" }));
  // No date is worse than an old one, so a missing `updated:` or question date
  // counts as overdue rather than disappearing from the report.
  const stale = problems
    .filter((p) => p.status === "active" && (daysAgo(p.updated) ?? Infinity) >= staleDays)
    .map((p) => ({ id: p.id, title: p.title, thread: p.thread, days: daysAgo(p.updated) }));
  const pending = problems
    .filter((p) => p.pending && (daysAgo(p.pending.date) ?? Infinity) >= 1)
    .map((p) => ({ id: p.id, title: p.title, kind: p.pending.kind, days: daysAgo(p.pending.date) }));
  const sessions = sessionSizes(agent, { hours });
  const turns = await readTurns(turnsPath(overlay, agent));
  const days = Object.entries(turns)
    .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v && typeof v === "object")
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 7);
  const totals = days.reduce(
    (acc, [, v]) => ({ person: acc.person + (v.person ?? 0), automated: acc.automated + (v.automated ?? 0), aboveWarn: acc.aboveWarn + (v.aboveWarn ?? 0) }),
    { person: 0, automated: 0, aboveWarn: 0 },
  );
  const window = days.length ? days[days.length - 1][0] : null;
  const ledger = await readLedger(ledgerPath(overlay, agent));
  const flagged = ledger.filter((e) => e.flag && (!window || e.day >= window));
  return {
    agent,
    notice,
    parked,
    stale,
    pending,
    largestSession: sessions[0] ?? null,
    turns: { ...totals, days: days.length, shareAboveWarn: totals.person ? Math.round((totals.aboveWarn / totals.person) * 100) : null },
    flagged,
    pins: { checked: false, reason: "the pin adapter is not deployed yet" },
  };
}

async function cmdReport() {
  const overlay = overlayDir();
  const named = flag("agents");
  const agents = named ? named.split(",").map((s) => s.trim()).filter(Boolean) : await agentsIn(overlay);
  const staleDays = Number(flag("stale-days") ?? 7);
  const hours = Number(flag("hours") ?? 24);
  const rows = [];
  for (const agent of agents) rows.push(await reportOne(overlay, agent, { staleDays, hours }));

  if (has("json")) {
    console.log(JSON.stringify({ overlay, staleDays, agents: rows }, null, 2));
    return;
  }
  if (!rows.length) console.log(`No agents in ${path.join(overlay, "agents")}.`);
  for (const r of rows) {
    console.log(`\n${r.agent}`);
    if (r.notice) console.log(`  register: ${r.notice}`);
    console.log(`  parked: ${r.parked.length ? r.parked.map((p) => `${p.id} ${p.title} (${p.days ?? "no date"}${p.days === null ? "" : "d"}${p.state ? `, ${p.state}` : ""})`).join("; ") : "none"}`);
    if (r.stale.length) console.log(`  untouched ${staleDays}+ days: ${r.stale.map((p) => `${p.id} ${p.title} (${p.days === null ? "no date" : `${p.days}d`})`).join("; ")}`);
    if (r.pending.length) console.log(`  waiting on an answer: ${r.pending.map((p) => `${p.id} ${p.kind} (${p.days === null ? "no date" : `${p.days}d`})`).join("; ")}`);
    const s = r.largestSession;
    console.log(`  largest live session: ${s ? `${s.session} ${Math.round(s.tokens / 1000)}k${s.fresh ? "" : " (last known)"}` : "none in the window"}`);
    console.log(`  turns over ${r.turns.days} day(s): ${r.turns.person} from the operator, ${r.turns.automated} automated, ${r.turns.shareAboveWarn ?? "–"}% of theirs above the warning level`);
    if (r.flagged.length) console.log(`  flagged: ${r.flagged.map((e) => `${e.day} ${e.problem} ${e.kind} — ${e.flag}`).join("; ")}`);
    if (!r.pins.checked) console.log(`  pins: not checked (${r.pins.reason})`);
  }
}

// -------------------------------------------------------------- aps install

const SOURCE_CORE = process.env.APS_PACK_FROM ? path.resolve(process.env.APS_PACK_FROM) : packageRoot();
const installedHome = stableHome();
const CORE = existsSync(installedHome) ? installedHome : SOURCE_CORE;

/** Which runtimes are on this machine, so `aps install` with no target works. */
async function runtimesPresent() {
  const found = [];
  if (await exists(claudeConfigDir())) found.push("claude-code");
  if (await exists(codexHome())) found.push("codex");
  if (await exists(openclawConfigFile())) found.push("openclaw");
  return found;
}

function report(result, target, dryRun) {
  if (!result.ok) {
    console.error(`aps: ${target}: ${result.reason}`);
    return false;
  }
  if (!result.changed) {
    console.log(`${target}: already installed, nothing to change`);
    return true;
  }
  console.log(`${target}: ${dryRun ? "would write" : "wrote"}`);
  for (const f of result.wrote) console.log(`  ${f}`);
  if (result.note) console.log(`  ${result.note}`);
  return true;
}

async function cmdInstall() {
  if (has("status")) return cmdStatus();
  const dryRun = has("dry-run");
  const asked = positional(0).slice(1);
  const targets = asked.length ? asked : await runtimesPresent();
  if (!targets.length) die("found no runtime to install into; pass claude-code, codex, openclaw or agents-md");

  const agent = flag("agent") ?? process.env.APS_AGENT ?? null;
  const agents = targets.includes("openclaw") ? (flag("agents") ?? agent ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];

  // Everything is checked before the first write. A run that installs Claude
  // Code and then dies on a name it does not know leaves the machine half done.
  const KNOWN = new Set(["claude-code", "codex", "openclaw", "agents-md"]);
  for (const target of targets) {
    if (!KNOWN.has(target)) die(`unknown install target "${target}": use claude-code, codex, openclaw or agents-md`);
  }
  for (const id of [agent, ...agents].filter(Boolean)) {
    const bad = agentIdError(id);
    if (bad) die(bad);
  }

  const overlayPath = await chooseOverlay(targets);
  const cliTarget = targets.some((t) => ["claude-code", "codex", "agents-md"].includes(t));
  // OpenClaw already knows its agents by id, so its register is the one for
  // the agent it routes to by default.
  const clawIds = targets.includes("openclaw") ? (agents.length ? agents : [openclawDefaultAgent()]) : [];
  // One person with one agent names nothing: a fresh overlay gets one register
  // under a neutral name, and an overlay that already has one keeps it.
  let cliAgent = null;
  if (cliTarget) {
    const existing = (await agentsIn(overlayPath)).filter((id) => !clawIds.includes(id));
    const recorded = readSettings().agentId;
    const picked = cliAgentFor({ agent, recorded, existing });
    if (picked.error) die(picked.error);
    cliAgent = picked.id;
  }
  const ids = [...new Set([...(cliAgent ? [cliAgent] : []), ...clawIds])];
  const skillsDir = flag("skills-dir") ? path.resolve(flag("skills-dir")) : agentsSkillsDir();
  const projectFlag = flag("project");
  const project = path.resolve(projectFlag ?? process.cwd());
  // Recorded only when the command line would otherwise have to guess between
  // registers; a lone register is found without a name.
  const settingsAgent = agent ?? (cliTarget ? (ids.length > 1 ? cliAgent : undefined) : (agents.length === 1 ? agents[0] : undefined));

  const planned = settleCore(SOURCE_CORE, { dryRun: true });
  const steps = (core, namesFrom, stepDryRun) => {
    const out = [];
    out.push(["command", installBin({ core, dryRun: stepDryRun })]);
    for (const id of ids) {
      out.push([`register ${id}`, prepareOverlay({ core: namesFrom, overlayPath, agentId: id, dryRun: stepDryRun })]);
    }
    out.push(["settings", writeSettings({
      configHome: settingsDir(), overlayPath, agentId: settingsAgent,
      projects: cliTarget ? [project] : null,
      allProjects: cliTarget && has("all-projects"),
      explicitProject: projectFlag !== null,
      skillsDir: flag("skills-dir") ? skillsDir : null,
      dryRun: stepDryRun,
    })]);
    for (const target of targets) {
      if (target === "claude-code") out.push([target, installClaudeCode({ core, namesFrom, dryRun: stepDryRun })]);
      else if (target === "codex") out.push([target, installCodex({ core, namesFrom, skillsDir, dryRun: stepDryRun })]);
      else if (target === "openclaw") out.push([target, installOpenClaw({ core, overlayPath, agents, dryRun: stepDryRun })]);
      else if (target === "agents-md") {
        const file = path.resolve(flag("file") ?? path.join(process.cwd(), "AGENTS.md"));
        out.push([target, installAgentsMd({
          core, namesFrom, file, overlayPath, agentId: cliAgent, skillsDir, dryRun: stepDryRun,
        })]);
      }
    }
    return out;
  };

  // Every config parse, path requirement and name conflict is checked before
  // settleCore or any target writes. Dry-run reports this exact plan.
  const preflight = steps(planned.core, planned.source, true);
  const bad = preflight.find(([, result]) => !result.ok);
  if (bad) die(`${bad[0]}: ${bad[1].reason}`, 1);
  if (dryRun) {
    if (planned.moved) report({ ok: true, changed: true, wrote: planned.wrote }, "plugin", true);
    for (const [name, result] of preflight) report(result, name, true);
    return;
  }

  const settled = settleCore(SOURCE_CORE);
  let allOk = true;
  if (settled.moved) allOk = report({ ok: true, changed: true, wrote: settled.wrote }, "plugin", false) && allOk;
  for (const [name, result] of steps(settled.core, settled.source, false)) {
    allOk = report(result, name, false) && allOk;
  }
  if (!allOk) process.exit(1);
}

/**
 * Where the registry lives. --overlay wins; otherwise the person is asked, and
 * offered the place an earlier install recorded, then places scoped to where
 * this agent already keeps its things. With nobody at the keyboard the places
 * are listed and nothing is written, unless --yes accepts the first.
 */
async function chooseOverlay(targets) {
  const cwd = process.cwd();
  const home = process.env.HOME ? path.resolve(process.env.HOME) : os.homedir();
  const given = flag("overlay") ?? (process.env.APS_OVERLAY || null);
  if (given) return pickOverlay(given, [], { cwd, home });
  const choices = overlayChoices({ targets, cwd });
  if (has("yes")) return choices[0].path;
  const listed = choices.map((c, i) => `  ${i + 1}. ${c.label}: ${c.path}`).join("\n");
  if (!process.stdin.isTTY) {
    die(`install needs --overlay <path> to know where your problems are stored, or --yes to take the first of:\n${listed}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = await rl.question(`Where should your problems be stored?\n${listed}\nPick a number or type a path [1]: `);
      const picked = pickOverlay(answer, choices, { cwd, home });
      if (picked) return picked;
      console.error(`Not one of 1-${choices.length}.`);
    }
  } finally {
    rl.close();
  }
}

function cmdStatus() {
  const rows = installStatus({ core: CORE });
  console.log(`pack: ${CORE}`);
  console.log(`skills: ${skillNames(CORE).join(", ") || "none"}`);
  console.log(`settings: ${path.join(settingsDir(), "config.json")}`);
  for (const r of rows) {
    const yes = (v) => (v === null ? "unknown" : typeof v === "string" ? v : v ? "yes" : "no");
    console.log(`\n${r.runtime}${r.present ? "" : " (not on this machine)"}`);
    console.log(`  skills installed: ${yes(r.skills)}`);
    console.log(`  reminder every turn: ${yes(r.reminder)}`);
    if (r.problem) console.log(`  problem: ${r.problem}`);
  }
}

// --------------------------------------------------------------- aps doctor

async function cmdDoctor() {
  const problems = [];
  const say = (good, text) => {
    console.log(`${good ? "ok  " : "warn"} ${text}`);
    if (!good) problems.push(text);
  };

  const rows = installStatus({ core: CORE });
  const live = rows.filter((r) => r.present);
  say(live.length > 0, live.length ? `runtimes found: ${live.map((r) => r.runtime).join(", ")}` : "no supported runtime found on this machine");
  for (const r of live) {
    say(r.skills === true, `${r.runtime}: skills installed`);
    if (r.reminder === "installed, not yet trusted") console.log(`info ${r.runtime}: reminder installed; trust not checked, run /hooks once`);
    else say(r.reminder === true, `${r.runtime}: a reminder on every turn`);
    if (r.problem) say(false, `${r.runtime}: ${r.problem}`);
  }

  const installed = runtimeConfig();
  const overlay = flag("overlay") ?? installed.overlayPath ?? null;
  if (!overlay) {
    say(false, "no overlay: pass --overlay <path> or set APS_OVERLAY");
  } else {
    const dir = path.resolve(overlay);
    say(await exists(dir), `overlay at ${dir}`);
    const all = await agentsIn(dir);
    say(all.length > 0, all.length ? `registers for: ${all.join(", ")}` : `no agents in ${path.join(dir, "agents")}`);
    for (const a of all) {
      const file = registerPath(dir, a, registerFile());
      if (!(await exists(file))) {
        say(false, `${a}: no register at ${file}`);
        continue;
      }
      const register = parseRegister(await readFile(file, "utf8"));
      const bad = lintRegister(register);
      say(bad.length === 0, bad.length ? `${a}: ${bad.length} problem(s) in the register — run aps lint --agent ${a}` : `${a}: register is valid`);
      say(Boolean(register.mission), `${a}: mission line set`);
    }
  }
  if (problems.length) process.exit(1);
}

// ------------------------------------------------------------------ main

const USAGE = `aps — one problem per thread

  aps set <ID> field=value…   change a problem; stamps the date and logs it
      --confirmed             record that the operator said yes, today
      --clear-pending         clear an answered question
  aps lint [--all]            check a register against the rules
  aps report                  parked, stale, waiting, session sizes, flags
      --agents <id>,<id>  --json  --stale-days 7  --hours 24
  aps install [<runtime>…]    install into claude-code, codex, openclaw or
                              agents-md; with no runtime, whichever are here
      --overlay <path>        where your problems are stored; asked if left out
      --yes                   take the first suggested place without asking
      --agent <id>            name the agent, if you run more than one
      --project <path>        only remind inside this project (default: cwd)
      --all-projects          remind in every directory
      --dry-run               print the change without making it
      --skills-dir <path>     where to link the skills (codex and its family)
      --status                what is installed where
  aps doctor                  is the install sound, per runtime?

  --overlay <abs path> (or APS_OVERLAY), --agent <id> (or APS_AGENT),
  --register <file>, --tz <IANA zone> (or APS_TZ)`;

// The subcommand is the first argument that is not a flag or a flag's value,
// so `aps --overlay X set P1 …` parses the same as `aps set P1 … --overlay X`.
const command = positional(0)[0];
try {
  if (command === "set") await cmdSet();
  else if (command === "lint") await cmdLint();
  else if (command === "report") await cmdReport();
  else if (command === "install") await cmdInstall();
  else if (command === "doctor") await cmdDoctor();
  else if (!command || has("help") || command === "help") console.log(USAGE);
  else die(`unknown command "${command}"\n\n${USAGE}`);
} catch (err) {
  die(err?.message ?? String(err));
}
