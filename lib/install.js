// The plugin installs itself (R44, R45, KTD19, KTD20).
//
// Every target follows the same four rules, because a person running this has
// not read the source and should not have to trust it:
//   - back up any file that already exists before changing it
//   - change only the keys this pack owns, and leave the rest byte-identical
//   - do nothing on a second run, and say so
//   - with dryRun, report the same thing and write nothing
//
// A file that cannot be parsed stops the install. Overwriting someone's
// settings because we could not read them is the one outcome worth refusing.

import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync,
  readdirSync, symlinkSync, lstatSync, readlinkSync, renameSync, rmSync,
  statSync, chmodSync, unlinkSync,
  constants as fsConstants,
} from "node:fs";
import { DEFAULT_REGISTER_FILE, agentIdError } from "./paths.js";
import { readSettings } from "./settings.js";
import path from "node:path";
import os from "node:os";
import { shellArg } from "./self.js";

export const PLUGIN_ID = "agent-problem-solving";
// The register a person gets when they have one agent and have not named it.
export const DEFAULT_AGENT_ID = "default";
const MARK = "<!-- agent-problem-solving -->";

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "Z");

function ok(wrote, changed = true, extra = {}) {
  return { ok: true, changed, wrote, ...extra };
}
const fail = (reason) => ({ ok: false, changed: false, wrote: [], reason });

/** Read JSON, telling the difference between "not there" and "not readable". */
function readJson(file) {
  if (!existsSync(file)) return { data: {}, existed: false };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { error: `${file} could not be read: ${err.message}` };
  }
  if (!text.trim()) return { data: {}, existed: true, text };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: `${file} could not be read as JSON: it is not an object` };
    return { data, existed: true, text };
  } catch (err) {
    return { error: `${file} could not be read as JSON: ${err.message}` };
  }
}

function backup(file) {
  const base = `${file}.bak-${stamp()}`;
  for (let n = 0; ; n += 1) {
    const target = n ? `${base}-${n}` : base;
    try {
      copyFileSync(file, target, fsConstants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
}

function writeText(file, text, { existed, dryRun, privateFile = false }) {
  if (dryRun) return [file];
  mkdirSync(path.dirname(file), { recursive: true });
  const wrote = [];
  if (existed) wrote.push(backup(file));
  // Keep a dotfiles symlink intact. For an ordinary file, rename gives readers
  // either the complete old file or the complete new one, never half a JSON file.
  let linked = false;
  try { linked = lstatSync(file).isSymbolicLink(); } catch {}
  if (linked) {
    writeFileSync(file, text, "utf8");
  } else {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const mode = existed ? statSync(file).mode & 0o7777 : privateFile ? 0o600 : 0o644;
    writeFileSync(tmp, text, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  }
  wrote.push(file);
  return wrote;
}

function writeJson(file, data, { existed, dryRun }) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  return writeText(file, text, { existed, dryRun, privateFile: true });
}

// Single-quoted, so a dollar sign or a backtick in the path is not expanded by
// the shell the runtime hands the command to.
/** Where a copy of the pack can live for as long as the install does. */
export function stableHome(env = process.env) {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : os.homedir(), ".local", "share");
  return path.join(base, PLUGIN_ID);
}

/**
 * A pack run straight from `npx` lives in a cache directory that npm is free to
 * evict. Everything an install writes points at the pack, so the hook, the skill
 * links and the gateway's load path would all go dead at once, and the next
 * prompt would show an error. So a pack in a throwaway place is copied somewhere
 * stable first, and the install points at the copy.
 */
export function throwaway(core, env = process.env) {
  const p = path.resolve(core);
  if (p.includes(`${path.sep}_npx${path.sep}`) || /[\\/]\.npm[\\/]/.test(p)) return true;
  const tmp = path.resolve(env.TMPDIR || "/tmp");
  return p === tmp || p.startsWith(`${tmp}${path.sep}`);
}

export function settleCore(core, { env = process.env, dryRun = false } = {}) {
  const source = path.resolve(core);
  if (!throwaway(core, env)) return { core: source, source, moved: false, wrote: [] };
  const home = stableHome(env);
  if (dryRun) return { core: home, source, moved: true, wrote: [home] };
  mkdirSync(path.dirname(home), { recursive: true });
  const fresh = `${home}.new-${process.pid}`;
  const old = `${home}.old-${process.pid}`;
  rmSync(fresh, { recursive: true, force: true });
  cpSync(core, fresh, { recursive: true, dereference: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  if (existsSync(home)) renameSync(home, old);
  renameSync(fresh, home);
  rmSync(old, { recursive: true, force: true });
  return { core: home, source, moved: true, wrote: [home] };
}

export const hookCommand = (core) => `node ${shellArg(path.join(core, "hooks", "reminder.mjs"))}`;

function reminderHandler(core) {
  return {
    type: "command",
    command: hookCommand(core),
    timeout: 5,
    statusMessage: "Reading the active problem",
  };
}

/**
 * Add our handler beside anyone else's, at handler level rather than group
 * level. Dropping the whole group that holds our command would take their
 * handler with it, and rewriting our own handler would undo a timeout they
 * raised deliberately.
 */
export function isOurHook(handler) {
  const cmd = String(handler?.command ?? "").replaceAll("\\", "/");
  return handler?.statusMessage === "Reading the active problem" || /\/hooks\/reminder\.mjs['"]?$/.test(cmd);
}

function mergeHook(hooks, core) {
  const existing = Array.isArray(hooks?.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const mine = hookCommand(core);
  const alreadyThere = existing.some((g) => (g?.hooks ?? []).some((h) => h?.command === mine));
  if (alreadyThere) return { next: { ...(hooks ?? {}), UserPromptSubmit: existing }, alreadyThere: true };
  const kept = existing
    .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((h) => !isOurHook(h)) }))
    .filter((group) => group.hooks.length);
  return { next: { ...(hooks ?? {}), UserPromptSubmit: [...kept, { hooks: [reminderHandler(core)] }] }, alreadyThere: false };
}

// --------------------------------------------------------------- the skills

export function skillNames(core) {
  try {
    return readdirSync(path.join(core, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(core, "skills", e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Link each skill into the runtime's skills directory. A link, not a copy, so
 * updating the pack updates every agent that has it.
 *
 * Nothing already there is ever removed. "focus" and "reframe" are names anyone
 * might have used, and an installer that deletes a directory it did not create
 * is not one worth trusting. A name that is taken comes back as a conflict, and
 * a dry run reports it before any write happens.
 */
function ownedPackTarget(rawTarget, link, expectedTail) {
  if (!rawTarget) return false;
  const resolved = path.resolve(path.dirname(link), rawTarget);
  if (!resolved.replaceAll("\\", "/").endsWith(expectedTail)) return false;
  const root = expectedTail.startsWith("/skills/") ? path.dirname(path.dirname(resolved)) : path.dirname(path.dirname(resolved));
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === PLUGIN_ID;
  } catch {
    return resolved.includes(`${path.sep}_npx${path.sep}`) || resolved.includes(PLUGIN_ID);
  }
}

export function linkSkills(core, dir, { dryRun = false, namesFrom = core } = {}) {
  const wrote = [];
  const conflicts = [];
  const plan = [];
  for (const name of skillNames(namesFrom)) {
    const target = path.join(core, "skills", name);
    const link = path.join(dir, name);
    let current;
    try {
      current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "";
    } catch {
      plan.push([target, link]);
      wrote.push(link);
      continue;
    }
    if (current === target) continue;
    if (current && ownedPackTarget(current, link, `/skills/${name}`)) {
      plan.push([target, link, true]);
      wrote.push(link);
      continue;
    }
    conflicts.push(current ? `${link} is a link to ${current}` : `${link} already exists and this install did not create it`);
  }
  if (conflicts.length) return { wrote: [], changed: false, conflicts };
  if (dryRun) return { wrote, changed: wrote.length > 0, conflicts: [] };
  mkdirSync(dir, { recursive: true });
  for (const [target, link, replace] of plan) {
    try {
      if (replace) unlinkSync(link);
      symlinkSync(target, link);
    } catch (err) {
      // Another install got there first between the check and the write. If it
      // landed on the same target the result is what we wanted anyway.
      if (err?.code !== "EEXIST") throw err;
      let current = "";
      try {
        current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "";
      } catch {
        current = "";
      }
      if (current !== target) return { wrote: [], changed: false, conflicts: [`${link} appeared while installing`] };
    }
  }
  return { wrote, changed: wrote.length > 0, conflicts: [] };
}

/** Put the command on the user's normal local PATH without replacing anything. */
export function installBin({ core, env = process.env, dryRun = false } = {}) {
  const home = env.HOME ? path.resolve(env.HOME) : os.homedir();
  const dir = env.APS_BIN_DIR ? path.resolve(env.APS_BIN_DIR) : path.join(home, ".local", "bin");
  const link = path.join(dir, "aps");
  const target = path.join(core, "bin", "aps.mjs");
  try {
    const info = lstatSync(link);
    if (info.isSymbolicLink() && readlinkSync(link) === target) return ok([], false, { file: link });
    if (info.isSymbolicLink() && ownedPackTarget(readlinkSync(link), link, "/bin/aps.mjs")) {
      if (!dryRun) unlinkSync(link);
    } else {
      return fail(`${link} already exists and this install did not create it`);
    }
  } catch {}
  const onPath = String(env.PATH ?? "").split(path.delimiter).map((p) => path.resolve(p || ".")).includes(dir);
  const note = onPath ? null : `${dir} is not on PATH; add it before using the bare aps command.`;
  if (dryRun) return ok([link], true, { file: link, ...(note ? { note } : {}) });
  mkdirSync(dir, { recursive: true });
  try {
    symlinkSync(target, link);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return fail(`${link} appeared while installing`);
  }
  return ok([link], true, { file: link, ...(note ? { note } : {}) });
}

// ----------------------------------------------------------- Claude Code

export function claudeConfigDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  return path.join(env.HOME ? path.resolve(env.HOME) : os.homedir(), ".claude");
}

export function installClaudeCode({ core, configDir = claudeConfigDir(), dryRun = false, namesFrom = core } = {}) {
  const file = path.join(configDir, "settings.json");
  const read = readJson(file);
  if (read.error) return fail(read.error);
  const { next, alreadyThere } = mergeHook(read.data.hooks, core);
  const settings = { ...read.data, hooks: next };
  const same = read.existed && JSON.stringify(settings) === JSON.stringify(read.data);
  const skills = linkSkills(core, path.join(configDir, "skills"), { dryRun, namesFrom });
  if (skills.conflicts?.length) return fail(`${skills.conflicts.join("; ")}. Move or remove it, then run this again.`);
  if (same && !skills.changed) return ok([], false, { runtime: "claude-code", file });
  const wrote = writeJson(file, settings, { existed: read.existed, dryRun });
  return ok([...wrote, ...skills.wrote], true, { runtime: "claude-code", file, replacedOwnHook: alreadyThere });
}

// ------------------------------------------------------------------ Codex

export function codexHome(env = process.env) {
  if (env.CODEX_HOME) return path.resolve(env.CODEX_HOME);
  return path.join(env.HOME ? path.resolve(env.HOME) : os.homedir(), ".codex");
}

// Codex and the other agents that share this directory read skills from here.
// APS_SKILLS_DIR points it somewhere else, which is how an install can be tried
// in a throwaway profile without touching the real one.
export function agentsSkillsDir(env = process.env) {
  if (env.APS_SKILLS_DIR) return path.resolve(env.APS_SKILLS_DIR);
  const home = env.HOME ? path.resolve(env.HOME) : os.homedir();
  return path.join(home, ".agents", "skills");
}

export function installCodex({ core, codexHome: home = codexHome(), skillsDir = agentsSkillsDir(), dryRun = false, namesFrom = core } = {}) {
  const file = path.join(home, "hooks.json");
  const read = readJson(file);
  if (read.error) return fail(read.error);
  const { next } = mergeHook(read.data.hooks, core);
  // Nothing beyond the hooks themselves: an unknown top-level key risks Codex
  // refusing to parse the file, which would silently drop every hook in it.
  const hooks = { ...read.data, hooks: next };
  const same = read.existed && JSON.stringify(hooks) === JSON.stringify(read.data);
  const skills = linkSkills(core, skillsDir, { dryRun, namesFrom });
  if (skills.conflicts?.length) return fail(`${skills.conflicts.join("; ")}. Move or remove it, then run this again.`);
  if (same && !skills.changed) return ok([], false, { runtime: "codex", file });
  const wrote = writeJson(file, hooks, { existed: read.existed, dryRun });
  return ok([...wrote, ...skills.wrote], true, { runtime: "codex", file, note: "Codex asks you to trust a new hook: run /hooks once." });
}

// --------------------------------------------------------------- OpenClaw

export function openclawConfigFile(env = process.env) {
  const root = env.OPENCLAW_STATE_DIR ? path.resolve(env.OPENCLAW_STATE_DIR) : path.join(env.HOME ? path.resolve(env.HOME) : os.homedir(), ".openclaw");
  return path.join(root, "openclaw.json");
}

/**
 * OpenClaw calls a function rather than a process, so the pack installs itself
 * as a plugin: one load path and one entry, both named after this plugin.
 */
export function installOpenClaw({ core, configFile = openclawConfigFile(), overlayPath, agents = [], dryRun = false, warnTokens, highTokens } = {}) {
  if (!overlayPath || !path.isAbsolute(overlayPath)) return fail(`the overlay path must be absolute, not "${overlayPath ?? ""}"`);
  if (!dryRun && !existsSync(overlayPath)) return fail(`no overlay directory at ${overlayPath}`);
  const read = readJson(configFile);
  if (read.error) return fail(read.error);
  if (!read.existed) return fail(`no gateway config at ${configFile}`);

  const before = JSON.stringify(read.data);
  const data = JSON.parse(before);
  const plugins = (data.plugins ??= {});
  const load = (plugins.load ??= {});
  const paths = Array.isArray(load.paths) ? load.paths : [];
  // A path that ends in this plugin's own directory name is an older copy of
  // this same plugin, so it is replaced. Two load paths for one plugin id is
  // not a state the gateway can resolve.
  const mine = (p) => p === core || path.basename(String(p ?? "")) === PLUGIN_ID || String(p ?? "").endsWith(`/${PLUGIN_ID}/core`);
  const kept = paths.filter((p) => !mine(p));
  load.paths = [...kept, core];

  const entries = (plugins.entries ??= {});
  const was = entries[PLUGIN_ID] ?? null;
  // Merge, never replace. A re-run with no --agents must not drop the agent
  // filter and start injecting into every agent on the gateway, and must not
  // switch an entry the operator disabled back on.
  entries[PLUGIN_ID] = {
    ...(was ?? {}),
    enabled: was && was.enabled === false ? false : true,
    config: {
      ...(was?.config ?? {}),
      overlayPath,
      ...(agents.length ? { agents } : {}),
      ...(Number.isFinite(warnTokens) ? { warnTokens } : {}),
      ...(Number.isFinite(highTokens) ? { highTokens } : {}),
    },
  };
  if (JSON.stringify(data) === before) return ok([], false, { runtime: "openclaw", file: configFile });
  const wrote = writeJson(configFile, data, { existed: true, dryRun });
  return ok(wrote, true, { runtime: "openclaw", file: configFile, note: "Restart the gateway for the hook to load." });
}

// ------------------------------------------------- a runtime with no hook

const AGENTS_BLOCK = (core, overlayPath, agentId, registerFile) => `${MARK}
## The active problem

This runtime has no hook, so nothing puts the active problem in front of you.
At the start of every reply, read this problem file:

    ${path.join(overlayPath, "agents", agentId, registerFile)}

Work only on the active entry whose thread matches this project. Change it with:

    node ${shellArg(path.join(core, "bin", "aps.mjs"))} set <ID> field=value --overlay ${shellArg(overlayPath)} --agent ${shellArg(agentId)}

Use the frame-problem, focus, reframe and close-problem skills. A reminder you
have to remember to read is weaker than one the runtime delivers; where the
runtime has a hook, install that instead.
${MARK}`;

export function installAgentsMd({ core, file, overlayPath, agentId, registerFile = DEFAULT_REGISTER_FILE, skillsDir, namesFrom = core, dryRun = false } = {}) {
  if (!overlayPath || !path.isAbsolute(overlayPath)) return fail("the agents-md fallback needs --overlay <absolute path>");
  if (!agentId) return fail("the agents-md fallback needs --agent <id>");
  const skills = linkSkills(core, skillsDir, { dryRun, namesFrom });
  if (skills.conflicts?.length) return fail(`${skills.conflicts.join("; ")}. Move or remove it, then run this again.`);
  let text = "";
  const existed = existsSync(file);
  if (existed) {
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      return fail(`${file} could not be read: ${err.message}`);
    }
  }
  const block = AGENTS_BLOCK(core, overlayPath, agentId, registerFile);
  const first = text.indexOf(MARK);
  const second = first < 0 ? -1 : text.indexOf(MARK, first + MARK.length);
  const next = first >= 0 && second >= 0
    ? `${text.slice(0, first)}${block}${text.slice(second + MARK.length)}`
    : `${text.replace(/\s*$/, "")}\n\n${block}\n`;
  if (next === text && !skills.changed) return ok([], false, { runtime: "agents-md", file });
  if (dryRun) return ok([...(next === text ? [] : [file]), ...skills.wrote], true, { runtime: "agents-md", file });
  const wrote = next === text ? [] : writeText(file, next, { existed, dryRun: false });
  return ok([...wrote, ...skills.wrote], true, { runtime: "agents-md", file });
}

// ------------------------------------------------ where the registry lives

function gitRoot(dir) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, ".git"))) return at;
    if (path.dirname(at) === at) return null;
  }
}

/** The workspace OpenClaw runs its agents in, from its own config when set. */
export function openclawWorkspace(env = process.env) {
  const file = openclawConfigFile(env);
  const read = readJson(file);
  const set = read.data?.agents?.defaults?.workspace;
  if (typeof set === "string" && set.trim()) {
    const home = env.HOME ? path.resolve(env.HOME) : os.homedir();
    return path.resolve(set.trim().replace(/^~(?=$|\/)/, home));
  }
  return path.join(path.dirname(file), "workspace");
}

/** The agent OpenClaw routes to when nothing names one: its default, else "main". */
export function openclawDefaultAgent(env = process.env) {
  const list = readJson(openclawConfigFile(env)).data?.agents?.list;
  const agents = Array.isArray(list) ? list.filter((a) => a && typeof a.id === "string") : [];
  return (agents.find((a) => a.default === true) ?? agents[0])?.id ?? "main";
}

/**
 * The places install offers for the registry, nearest first. Each is scoped to
 * where the agent already keeps its own things: the repository the install runs
 * in, then the home directory of each runtime being installed. Never a folder
 * at the top of the home directory, which would be shared by everything.
 * When an earlier install already recorded a place, that one comes first, so a
 * re-run or a second runtime keeps using the same registry by default.
 */
export function overlayChoices({ targets = [], cwd = process.cwd(), env = process.env } = {}) {
  const out = [];
  const add = (label, dir) => {
    if (!out.some((c) => c.path === dir)) out.push({ label, path: dir });
  };
  const current = readSettings(env).overlayPath;
  if (typeof current === "string" && path.isAbsolute(current.trim())) {
    add("where your problems are stored now", path.resolve(current.trim()));
  }
  const repo = gitRoot(cwd);
  if (repo) add(`this repository (${path.basename(repo)})`, path.join(repo, ".problems"));
  for (const t of targets) {
    if (t === "claude-code") add("Claude Code's directory", path.join(claudeConfigDir(env), "problems"));
    else if (t === "codex") add("Codex's directory", path.join(codexHome(env), "problems"));
    else if (t === "openclaw") add("the OpenClaw workspace", path.join(openclawWorkspace(env), "problems"));
  }
  if (!out.length) add("this directory", path.join(path.resolve(cwd), ".problems"));
  return out;
}

/**
 * The register a command-line install is for when no --agent names one. An
 * overlay that already holds one register keeps using it, and one that holds
 * several needs a name: adding a neutral one beside them would leave the hook
 * unable to tell which is meant. Only an empty overlay gets the neutral name.
 */
export function cliAgentFor({ agent = null, recorded = null, existing = [] } = {}) {
  if (agent) return { id: agent };
  if (typeof recorded === "string" && existing.includes(recorded)) return { id: recorded };
  if (existing.length === 1) return { id: existing[0] };
  if (!existing.length) return { id: DEFAULT_AGENT_ID };
  return { error: `pass --agent: the overlay already holds ${existing.length} agents (${existing.join(", ")}); name the one this install is for` };
}

/** Turn an answer into a path: blank is the first choice, a number picks one, anything else is a path. */
export function pickOverlay(answer, choices, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const a = String(answer ?? "").trim();
  if (!a) return choices[0]?.path ?? null;
  // A number picks from a menu; with no menu (an --overlay value) it is a folder name.
  if (/^\d+$/.test(a) && choices.length) return choices[Number(a) - 1]?.path ?? null;
  return path.resolve(cwd, a.replace(/^~(?=$|\/)/, home));
}

// -------------------------------------------------------- the first overlay

/**
 * Make the overlay and one register from the bundled template when they are
 * missing, so an install is one command rather than a command plus a file the
 * person has to find. An existing register is never touched.
 */
export function prepareOverlay({ core, overlayPath, agentId, dryRun = false } = {}) {
  if (!overlayPath || !path.isAbsolute(overlayPath)) return fail(`the overlay path must be absolute, not "${overlayPath ?? ""}"`);
  const id = String(agentId ?? "").trim() || DEFAULT_AGENT_ID;
  const bad = agentIdError(id);
  if (bad) return fail(bad);
  const register = path.join(overlayPath, "agents", id, DEFAULT_REGISTER_FILE);
  if (existsSync(register)) return ok([], false, { register });
  if (dryRun) return ok([register], true, { register });
  let template;
  try {
    template = readFileSync(path.join(core, "templates", DEFAULT_REGISTER_FILE), "utf8");
  } catch (err) {
    return fail(`the register template is missing from this package: ${err.message}`);
  }
  mkdirSync(path.dirname(register), { recursive: true });
  writeFileSync(register, template, "utf8");
  return ok([register], true, { register });
}

// ---------------------------------------------------------------- settings

/** Where the hook finds the overlay without anyone exporting a variable. */
export function writeSettings({ configHome, overlayPath, agentId, projects = null, allProjects = false, explicitProject = false, skillsDir = null, dryRun = false } = {}) {
  if (!overlayPath || !path.isAbsolute(overlayPath)) return fail(`the overlay path must be absolute, not "${overlayPath ?? ""}"`);
  const file = path.join(configHome, "config.json");
  const read = readJson(file);
  if (read.error) return fail(read.error);
  const was = Array.isArray(read.data.projects) ? read.data.projects : [];
  // A project is added to the list, never over it, so installing in a second
  // repository does not switch the reminder off in the first.
  const wasAll = read.existed && Array.isArray(read.data.projects) && read.data.projects.length === 0;
  const nextProjects = allProjects || (wasAll && !explicitProject)
    ? []
    : [...new Set([...was, ...(projects ?? []).map((p) => path.resolve(p))])];
  const includeProjects = allProjects || projects !== null || Array.isArray(read.data.projects);
  const next = {
    ...read.data,
    overlayPath,
    ...(agentId ? { agentId } : {}),
    ...(includeProjects ? { projects: nextProjects } : {}),
    // Only recorded when it is not the default, so `status`/`doctor` can find
    // skills a person chose to link somewhere else (codex and its family).
    ...(skillsDir ? { skillsDir } : {}),
  };
  if (read.existed && JSON.stringify(next) === JSON.stringify(read.data)) return ok([], false, { file });
  const wrote = writeJson(file, next, { existed: read.existed, dryRun });
  return ok(wrote, true, { file });
}

// ------------------------------------------------------------------ status

const hasOurHook = (hooks, core) =>
  (Array.isArray(hooks?.UserPromptSubmit) ? hooks.UserPromptSubmit : []).some((g) => (g?.hooks ?? []).some((h) => isOurHook(h)));

/**
 * What is actually in place, per runtime, read from the files themselves. Used
 * by `aps install --status` and by `aps doctor`, so both tell the same story.
 */
export function installStatus({ core, env = process.env } = {}) {
  const rows = [];

  const claudeDir = claudeConfigDir(env);
  const claude = readJson(path.join(claudeDir, "settings.json"));
  rows.push({
    runtime: "claude-code",
    present: existsSync(claudeDir),
    reminder: claude.error ? null : hasOurHook(claude.data?.hooks, core),
    skills: skillsLinked(core, path.join(claudeDir, "skills")),
    problem: claude.error ?? null,
  });

  const codex = codexHome(env);
  const codexHooks = readJson(path.join(codex, "hooks.json"));
  const codexInstalled = codexHooks.error ? null : hasOurHook(codexHooks.data?.hooks, core);
  const storedSkillsDir = readSettings(env).skillsDir;
  rows.push({
    runtime: "codex",
    present: existsSync(codex),
    reminder: codexInstalled ? "installed, not yet trusted" : codexInstalled,
    skills: skillsLinked(core, storedSkillsDir || agentsSkillsDir(env)),
    problem: codexHooks.error ?? null,
  });

  const gatewayFile = openclawConfigFile(env);
  const gateway = readJson(gatewayFile);
  const entry = gateway.error ? null : gateway.data?.plugins?.entries?.[PLUGIN_ID];
  rows.push({
    runtime: "openclaw",
    present: gateway.existed === true,
    reminder: gateway.error ? null : Boolean(entry && entry.enabled !== false && (gateway.data?.plugins?.load?.paths ?? []).includes(core)),
    skills: gateway.error ? null : Boolean(entry),
    problem: gateway.error ?? null,
  });

  return rows;
}

function skillsLinked(core, dir) {
  const names = skillNames(core);
  if (!names.length) return false;
  return names.every((name) => {
    try {
      const link = path.join(dir, name);
      return lstatSync(link).isSymbolicLink() ? readlinkSync(link) === path.join(core, "skills", name) : existsSync(path.join(link, "SKILL.md"));
    } catch {
      return false;
    }
  });
}
