// `aps install` (U13, R44). One command per runtime, run by someone who has not
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// read the source. Each target backs up what it edits, changes only the keys it
// owns, is safe to run twice, and can print the change without making it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installClaudeCode, installCodex, installOpenClaw, installAgentsMd, writeSettings, installBin } from "../lib/install.js";

const CORE = (await import("../lib/self.js")).packageRoot();

const home = () => mkdtempSync(path.join(tmpdir(), "aps-inst-"));
const read = (f) => readFileSync(f, "utf8");
const json = (f) => JSON.parse(read(f));

function overlay() {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-ov-"));
  mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "Mission: x\n");
  return dir;
}

// ------------------------------------------------------------- Claude Code

test("Claude Code gets the hook and the skills, and says what it wrote", () => {
  const dir = home();
  const r = installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(r.ok, true);
  const settings = json(path.join(dir, "settings.json"));
  const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(cmd.includes(path.join(CORE, "hooks", "reminder.mjs")), cmd);
  assert.ok(r.wrote.some((w) => w.includes("settings.json")));
  // The four skills are linked where Claude Code looks for them.
  assert.deepEqual(readdirSync(path.join(dir, "skills")).sort(), ["close-problem", "focus", "frame-problem", "reframe"]);
});

test("a second run changes nothing and says so", () => {
  const dir = home();
  installClaudeCode({ core: CORE, configDir: dir });
  const before = read(path.join(dir, "settings.json"));
  const r = installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(read(path.join(dir, "settings.json")), before);
});

test("another tool's settings survive, including its own hooks", () => {
  const dir = home();
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ model: "opus", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
  );
  installClaudeCode({ core: CORE, configDir: dir });
  const after = json(path.join(dir, "settings.json"));
  assert.equal(after.model, "opus");
  assert.equal(after.hooks.SessionStart[0].hooks[0].command, "echo hi");
  assert.equal(after.hooks.UserPromptSubmit.length, 1);
});

test("someone else's UserPromptSubmit hook is kept beside ours", () => {
  const dir = home();
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "theirs.sh" }] }] } }));
  installClaudeCode({ core: CORE, configDir: dir });
  const after = json(path.join(dir, "settings.json"));
  const commands = after.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.some((c) => c.includes("theirs.sh")));
  assert.ok(commands.some((c) => c.includes("reminder.mjs")));
});

test("an existing settings file is backed up before it is changed", () => {
  const dir = home();
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  installClaudeCode({ core: CORE, configDir: dir });
  const backup = readdirSync(dir).find((f) => f.startsWith("settings.json.bak-"));
  assert.ok(backup, readdirSync(dir).join(", "));
  assert.equal(json(path.join(dir, backup)).model, "opus");
});

test("rewriting a private config preserves its 0600 mode", () => {
  const dir = home();
  const settings = path.join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "opus" }));
  chmodSync(settings, 0o600);
  installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(statSync(settings).mode & 0o777, 0o600);

  const gateway = path.join(dir, "openclaw.json");
  writeFileSync(gateway, JSON.stringify(GATEWAY));
  chmodSync(gateway, 0o600);
  installOpenClaw({ core: CORE, configFile: gateway, overlayPath: overlay(), agents: ["a"] });
  assert.equal(statSync(gateway).mode & 0o777, 0o600);
});

test("a settings file nobody can parse stops the install instead of overwriting it", () => {
  const dir = home();
  writeFileSync(path.join(dir, "settings.json"), "{ not json");
  const r = installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be read as JSON/);
  assert.equal(read(path.join(dir, "settings.json")), "{ not json");
});

test("a dry run writes nothing and still reports what it would do", () => {
  const dir = home();
  const r = installClaudeCode({ core: CORE, configDir: dir, dryRun: true });
  assert.equal(r.ok, true);
  assert.ok(r.wrote.length);
  assert.equal(existsSync(path.join(dir, "settings.json")), false);
  assert.equal(existsSync(path.join(dir, "skills")), false);
});

// ------------------------------------------------------------------- Codex

test("Codex gets the hook in its own hooks file and the skills in the shared directory", () => {
  const dir = home();
  const agents = path.join(dir, "agents-skills");
  const r = installCodex({ core: CORE, codexHome: dir, skillsDir: agents });
  assert.equal(r.ok, true);
  const hooks = json(path.join(dir, "hooks.json"));
  const cmd = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(cmd.includes(path.join(CORE, "hooks", "reminder.mjs")), cmd);
  assert.deepEqual(readdirSync(agents).sort(), ["close-problem", "focus", "frame-problem", "reframe"]);
});

test("Codex installed twice changes nothing", () => {
  const dir = home();
  installCodex({ core: CORE, codexHome: dir, skillsDir: path.join(dir, "s") });
  const before = read(path.join(dir, "hooks.json"));
  const r = installCodex({ core: CORE, codexHome: dir, skillsDir: path.join(dir, "s") });
  assert.equal(r.changed, false);
  assert.equal(read(path.join(dir, "hooks.json")), before);
});

// ---------------------------------------------------------------- OpenClaw

const GATEWAY = {
  agents: { list: [{ id: "other" }] },
  plugins: {
    entries: { "some-other-plugin": { enabled: true, config: { key: "value" } } },
    load: { paths: ["/opt/another-plugin"] },
  },
};

test("OpenClaw gets a load path and its own entry, and every other entry is untouched", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(GATEWAY, null, 2));
  const ov = overlay();
  const r = installOpenClaw({ core: CORE, configFile: file, overlayPath: ov, agents: ["a"] });
  assert.equal(r.ok, true);
  const after = json(file);
  assert.deepEqual(after.plugins.entries["some-other-plugin"], GATEWAY.plugins.entries["some-other-plugin"]);
  assert.deepEqual(after.agents, GATEWAY.agents);
  assert.ok(after.plugins.load.paths.includes("/opt/another-plugin"));
  assert.ok(after.plugins.load.paths.includes(CORE));
  const entry = after.plugins.entries["agent-problem-solving"];
  assert.equal(entry.enabled, true);
  assert.equal(entry.config.overlayPath, ov);
  assert.deepEqual(entry.config.agents, ["a"]);
});

test("the gateway config is backed up before it is changed", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(GATEWAY));
  installOpenClaw({ core: CORE, configFile: file, overlayPath: overlay(), agents: ["a"] });
  const backup = readdirSync(dir).find((f) => f.startsWith("openclaw.json.bak-"));
  assert.ok(backup);
  assert.deepEqual(json(path.join(dir, backup)), GATEWAY);
});

test("a gateway config nobody can parse stops the install", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, "{ nope");
  const r = installOpenClaw({ core: CORE, configFile: file, overlayPath: overlay(), agents: ["a"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be read as JSON/);
  assert.equal(read(file), "{ nope");
});

test("OpenClaw installed twice changes nothing", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(GATEWAY, null, 2));
  const ov = overlay();
  installOpenClaw({ core: CORE, configFile: file, overlayPath: ov, agents: ["a"] });
  const before = read(file);
  const r = installOpenClaw({ core: CORE, configFile: file, overlayPath: ov, agents: ["a"] });
  assert.equal(r.changed, false);
  assert.equal(read(file), before);
});

test("an overlay that does not exist stops the install, so a typo is not a second empty overlay", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(GATEWAY));
  const r = installOpenClaw({ core: CORE, configFile: file, overlayPath: "/tmp/aps-nope-987654", agents: ["a"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no overlay directory/);
});

test("a dry run on the gateway writes nothing", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(GATEWAY, null, 2));
  const before = read(file);
  const r = installOpenClaw({ core: CORE, configFile: file, overlayPath: overlay(), agents: ["a"], dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(read(file), before);
  assert.equal(readdirSync(dir).length, 1);
});

// ------------------------------------------------------------- instructions

test("a runtime with no hook gets one block in its instructions file, once", () => {
  const dir = home();
  const file = path.join(dir, "AGENTS.md");
  const ov = overlay();
  const skillsDir = path.join(dir, "skills");
  writeFileSync(file, "# My project\n\nSomething already here.\n");
  const r = installAgentsMd({ core: CORE, file, overlayPath: ov, agentId: "a", skillsDir });
  assert.equal(r.ok, true);
  const text = read(file);
  assert.match(text, /Something already here\./);
  assert.match(text, /no hook/i);
  assert.deepEqual(readdirSync(skillsDir).sort(), ["close-problem", "focus", "frame-problem", "reframe"]);
  const again = installAgentsMd({ core: CORE, file, overlayPath: ov, agentId: "a", skillsDir });
  assert.equal(again.changed, false);
  assert.equal(read(file), text);
});

// ---------------------------------------------------------------- settings

test("the settings the hook reads are written where it looks for them", () => {
  const dir = home();
  const ov = overlay();
  const r = writeSettings({ configHome: dir, overlayPath: ov, agentId: "a" });
  assert.equal(r.ok, true);
  assert.deepEqual(json(path.join(dir, "config.json")), { overlayPath: ov, agentId: "a" });
});

test("writing settings twice changes nothing", () => {
  const dir = home();
  const ov = overlay();
  writeSettings({ configHome: dir, overlayPath: ov, agentId: "a" });
  const r = writeSettings({ configHome: dir, overlayPath: ov, agentId: "a" });
  assert.equal(r.changed, false);
});

test("the skills are linked, not copied, so an update to the pack reaches them", () => {
  const dir = home();
  installClaudeCode({ core: CORE, configDir: dir });
  const link = path.join(dir, "skills", "focus");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.ok(existsSync(path.join(link, "SKILL.md")));
});

test("the command is linked into the user's local bin without replacing one", () => {
  const dir = home();
  const env = { HOME: dir };
  const first = installBin({ core: CORE, env });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const link = path.join(dir, ".local", "bin", "aps");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(installBin({ core: CORE, env }).changed, false);

  require("node:fs").unlinkSync(link);
  writeFileSync(link, "someone else's command\n");
  const conflict = installBin({ core: CORE, env });
  assert.equal(conflict.ok, false);
  assert.match(read(link), /someone else's command/);
});

// ------------------------------------------------------- through the command

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APS = fileURLToPath(new URL("../bin/aps.mjs", import.meta.url));

function aps(args, env = {}) {
  const r = spawnSync(process.execPath, [APS, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: env.HOME ?? process.env.HOME, APS_OVERLAY: "", APS_AGENT: "", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", OPENCLAW_STATE_DIR: "", APS_CONFIG_HOME: "", ...env },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** A machine with nothing installed: every runtime directory is a fresh temp. */
function machine() {
  const root = mkdtempSync(path.join(tmpdir(), "aps-machine-"));
  const env = {
    HOME: root,
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    CODEX_HOME: path.join(root, ".codex"),
    OPENCLAW_STATE_DIR: path.join(root, ".openclaw"),
    APS_CONFIG_HOME: path.join(root, "aps-config"),
  };
  return { root, env };
}

test("the command installs into Claude Code and reports every file it wrote", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const ov = overlay();
  const r = aps(["install", "claude-code", "--overlay", ov, "--agent", "a"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /claude-code: wrote/);
  assert.ok(existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")));
  assert.equal(json(path.join(env.APS_CONFIG_HOME, "config.json")).overlayPath, ov);
});

test("the command with no runtime named installs into whichever are on the machine", () => {
  const { env } = machine();
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const r = aps(["install", "--overlay", overlay(), "--agent", "a"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /codex: wrote/);
  assert.doesNotMatch(r.out, /claude-code:/);
});

test("the command finds no runtime and says what to pass instead of guessing", () => {
  const { env } = machine();
  const r = aps(["install", "--overlay", overlay()], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /found no runtime/);
});

test("a dry run through the command writes nothing", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const r = aps(["install", "claude-code", "--overlay", overlay(), "--agent", "a", "--dry-run"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would write/);
  assert.equal(existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);
});

test("installing into OpenClaw without an overlay stops rather than writing a broken entry", () => {
  const { env } = machine();
  mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"), JSON.stringify({ plugins: {} }));
  const r = aps(["install", "openclaw"], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /needs --overlay/);
});

test("status reads the files rather than remembering what it did", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  assert.match(aps(["install", "--status"], env).out, /claude-code\n {2}skills installed: no/);
  aps(["install", "claude-code", "--overlay", overlay(), "--agent", "a"], env);
  const after = aps(["install", "--status"], env).out;
  assert.match(after, /claude-code\n {2}skills installed: yes\n {2}reminder every turn: yes/);
});

test("doctor fails loudly when there is no overlay, and passes on a sound install", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const bare = aps(["doctor"], env);
  assert.equal(bare.code, 1);
  assert.match(bare.out, /no overlay/);

  const ov = overlay();
  writeFileSync(path.join(ov, "agents", "a", "PROBLEMS.md"), "Mission: ten artists on the platform\n");
  aps(["install", "claude-code", "--overlay", ov, "--agent", "a"], env);
  const good = aps(["doctor", "--overlay", ov], env);
  assert.equal(good.code, 0, `${good.out}\n${good.err}`);
  assert.match(good.out, /ok {3}claude-code: a reminder on every turn/);
  assert.match(good.out, /ok {3}a: mission line set/);
});

test("an unknown install target is refused, not silently skipped", () => {
  const { env } = machine();
  const r = aps(["install", "emacs", "--overlay", overlay()], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown install target/);
});

test("the shared skills directory can be pointed somewhere else, so a trial install stays contained", () => {
  const { env } = machine();
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const skills = path.join(env.HOME, "elsewhere");
  const r = aps(["install", "codex", "--overlay", overlay(), "--agent", "a", "--skills-dir", skills], env);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(skills).sort(), ["close-problem", "focus", "frame-problem", "reframe"]);
  assert.equal(existsSync(path.join(env.HOME, ".agents")), false);
});

// ------------------------------------------------------- nothing is destroyed

test("a real directory where a skill would go is a refusal, not a deletion", () => {
  const dir = home();
  const theirs = path.join(dir, "skills", "focus");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, "SKILL.md"), "---\nname: focus\n---\nTheir own focus skill.\n");
  const r = installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /focus/);
  assert.match(read(path.join(theirs, "SKILL.md")), /Their own focus skill/);
});

test("a symlink pointing somewhere else is a refusal too", () => {
  const dir = home();
  const other = mkdtempSync(path.join(tmpdir(), "aps-other-"));
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  require("node:fs").symlinkSync(other, path.join(dir, "skills", "reframe"));
  const r = installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reframe/);
});

test("a conflict is reported by a dry run before anything is written", () => {
  const dir = home();
  mkdirSync(path.join(dir, "skills", "focus"), { recursive: true });
  const r = installClaudeCode({ core: CORE, configDir: dir, dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /focus/);
});

test("someone else's handler in our own hook group survives a re-run", () => {
  const dir = home();
  installClaudeCode({ core: CORE, configDir: dir });
  const settings = json(path.join(dir, "settings.json"));
  settings.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "theirs.sh" });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  const r = installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(r.changed, false, JSON.stringify(r));
  const after = json(path.join(dir, "settings.json"));
  const commands = after.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.some((c) => c === "theirs.sh"), commands.join(" | "));
  assert.equal(commands.filter((c) => c.includes("reminder.mjs")).length, 1);
});

test("a timeout the user raised on our own handler is left alone", () => {
  const dir = home();
  installClaudeCode({ core: CORE, configDir: dir });
  const settings = json(path.join(dir, "settings.json"));
  settings.hooks.UserPromptSubmit[0].hooks[0].timeout = 30;
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  installClaudeCode({ core: CORE, configDir: dir });
  assert.equal(json(path.join(dir, "settings.json")).hooks.UserPromptSubmit[0].hooks[0].timeout, 30);
});

test("a re-run of the OpenClaw install keeps the config the user tuned", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  const ov = overlay();
  writeFileSync(file, JSON.stringify({
    plugins: {
      load: { paths: [CORE] },
      entries: { "agent-problem-solving": { enabled: true, config: { overlayPath: ov, agents: ["a", "b"], warnTokens: 300000, timeZone: "Europe/London" } } },
    },
  }, null, 2));
  const r = installOpenClaw({ core: CORE, configFile: file, overlayPath: ov });
  assert.equal(r.changed, false, JSON.stringify(r));
  const entry = json(file).plugins.entries["agent-problem-solving"];
  assert.deepEqual(entry.config.agents, ["a", "b"]);
  assert.equal(entry.config.warnTokens, 300000);
  assert.equal(entry.config.timeZone, "Europe/London");
});

test("a deliberately disabled entry is not switched back on", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  const ov = overlay();
  writeFileSync(file, JSON.stringify({ plugins: { load: { paths: [CORE] }, entries: { "agent-problem-solving": { enabled: false, config: { overlayPath: ov } } } } }, null, 2));
  installOpenClaw({ core: CORE, configFile: file, overlayPath: ov });
  assert.equal(json(file).plugins.entries["agent-problem-solving"].enabled, false);
});

test("a stale load path for this same plugin is replaced, not joined", () => {
  const dir = home();
  const file = path.join(dir, "openclaw.json");
  const ov = overlay();
  writeFileSync(file, JSON.stringify({
    plugins: { load: { paths: ["/opt/keep", "/old/npx/cache/agent-problem-solving"] }, entries: {} },
  }, null, 2));
  installOpenClaw({ core: CORE, configFile: file, overlayPath: ov });
  const paths = json(file).plugins.load.paths;
  assert.deepEqual(paths, ["/opt/keep", CORE]);
});

test("every target and its flags are checked before the first write", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const r = aps(["install", "claude-code", "emacs", "--overlay", overlay(), "--agent", "a"], env);
  assert.equal(r.code, 2);
  assert.equal(existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);

  const r2 = aps(["install", "claude-code", "openclaw", "--agent", "a"], env);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /--overlay/);
  assert.equal(existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);

  const ov = path.join(env.HOME, "fresh-problems");
  const r3 = aps(["install", "claude-code", "openclaw", "--overlay", ov, "--agent", "a"], env);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /no gateway config/);
  assert.equal(existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);
  assert.equal(existsSync(ov), false);
  assert.equal(existsSync(path.join(env.HOME, ".local", "bin", "aps")), false);
});

// ------------------------------------------------- a stable home and a setup

test("an install from a throwaway copy of the pack settles somewhere stable first", () => {
  const cache = mkdtempSync(path.join(tmpdir(), "_npx-"));
  const from = path.join(cache, "node_modules", "agent-problem-solving");
  require("node:fs").cpSync(CORE, from, { recursive: true });
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const stable = path.join(env.HOME, ".local", "share", "agent-problem-solving");

  const r = aps(["install", "claude-code", "--overlay", overlay(), "--agent", "a", "--all-projects"], { ...env, APS_PACK_FROM: from });
  assert.equal(r.code, 0, r.err);
  const cmd = json(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(cmd.includes(stable), cmd);
  assert.doesNotMatch(cmd, /_npx/);
  assert.ok(existsSync(path.join(stable, "hooks", "reminder.mjs")));
  // The copy still works after the throwaway one is gone.
  require("node:fs").rmSync(cache, { recursive: true, force: true });
  assert.ok(existsSync(path.join(stable, "hooks", "reminder.mjs")));
});

test("a throwaway dry run reports every skill link before the stable copy exists", () => {
  const cache = mkdtempSync(path.join(tmpdir(), "_npx-"));
  const from = path.join(cache, "node_modules", "agent-problem-solving");
  require("node:fs").cpSync(CORE, from, { recursive: true });
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const r = aps(["install", "claude-code", "--overlay", path.join(env.HOME, "problems"), "--agent", "a", "--dry-run"], { ...env, APS_PACK_FROM: from });
  assert.equal(r.code, 0, r.err);
  for (const name of ["close-problem", "focus", "frame-problem", "reframe"]) assert.match(r.out, new RegExp(`skills/${name}`));
  assert.equal(existsSync(path.join(env.HOME, ".local", "share", "agent-problem-solving")), false);
  assert.equal(existsSync(path.join(env.HOME, "problems")), false);
});

test("install creates the overlay and a register from the template when they are missing", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const ov = path.join(env.HOME, "problems");
  const r = aps(["install", "claude-code", "--overlay", ov, "--agent", "a", "--all-projects"], env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const register = path.join(ov, "agents", "a", "PROBLEMS.md");
  assert.ok(existsSync(register), r.out);
  assert.match(read(register), /Mission:/);
  // The installer cannot invent this agent's mission. Doctor names the one
  // human setup step left instead of claiming the register is ready.
  const doctor = aps(["doctor"], env);
  assert.equal(doctor.code, 1, doctor.out);
  assert.match(doctor.out, /mission line set/);
});

test("install records the directory it ran in, so the hook stays out of every other one", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const proj = path.join(env.HOME, "website");
  mkdirSync(proj, { recursive: true });
  const r = spawnSync(process.execPath, [APS, "install", "claude-code", "--overlay", path.join(env.HOME, "problems"), "--agent", "a"], {
    cwd: proj,
    encoding: "utf8",
    env: { ...process.env, APS_OVERLAY: "", APS_AGENT: "", ...env },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(json(path.join(env.APS_CONFIG_HOME, "config.json")).projects, [proj]);
});

test("--all-projects is the explicit way to want it everywhere", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  aps(["install", "claude-code", "--overlay", path.join(env.HOME, "problems"), "--agent", "a", "--all-projects"], env);
  assert.deepEqual(json(path.join(env.APS_CONFIG_HOME, "config.json")).projects, []);
});

test("a later install keeps an all-projects choice unless --project is explicit", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const ov = path.join(env.HOME, "problems");
  aps(["install", "claude-code", "--overlay", ov, "--agent", "a", "--all-projects"], env);
  aps(["install", "codex", "--overlay", ov, "--agent", "a", "--skills-dir", path.join(env.HOME, "codex-skills")], env);
  assert.deepEqual(json(path.join(env.APS_CONFIG_HOME, "config.json")).projects, []);
});

test("a second project is added beside the first, not over it", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const ov = path.join(env.HOME, "problems");
  const a = path.join(env.HOME, "one");
  const b = path.join(env.HOME, "two");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  aps(["install", "claude-code", "--overlay", ov, "--agent", "a", "--project", a], env);
  aps(["install", "claude-code", "--overlay", ov, "--agent", "a", "--project", b], env);
  assert.deepEqual(json(path.join(env.APS_CONFIG_HOME, "config.json")).projects.sort(), [a, b].sort());
});

test("Codex gets nothing in its hooks file beyond the hooks themselves", () => {
  const dir = home();
  installCodex({ core: CORE, codexHome: dir, skillsDir: path.join(dir, "s") });
  assert.deepEqual(Object.keys(json(path.join(dir, "hooks.json"))), ["hooks"]);
});

test("Codex status does not promise a reminder the trust prompt has not allowed yet", () => {
  const { env } = machine();
  mkdirSync(env.CODEX_HOME, { recursive: true });
  aps(["install", "codex", "--overlay", path.join(env.HOME, "problems"), "--agent", "a", "--all-projects", "--skills-dir", path.join(env.HOME, "s")], env);
  const out = aps(["install", "--status"], env).out;
  assert.match(out, /codex[\s\S]*reminder every turn: installed, not yet trusted/);
});

test("doctor treats Codex trust as information, not a permanent failure", () => {
  const { env } = machine();
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const ov = path.join(env.HOME, "problems");
  aps(["install", "codex", "--overlay", ov, "--agent", "a", "--skills-dir", path.join(env.HOME, "s")], env);
  const file = path.join(ov, "agents", "a", "PROBLEMS.md");
  writeFileSync(file, read(file).replace("Mission:", "Mission: finish the project"));
  const r = aps(["doctor"], env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /trust not checked/);
});

test("OpenClaw-only install writes settings so bare aps commands work", () => {
  const { env } = machine();
  mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"), JSON.stringify({ plugins: {} }));
  const ov = path.join(env.HOME, "problems");
  const install = aps(["install", "openclaw", "--overlay", ov, "--agents", "a"], env);
  assert.equal(install.code, 0, install.err);
  assert.equal(json(path.join(env.APS_CONFIG_HOME, "config.json")).overlayPath, ov);
  assert.equal(aps(["lint", "--agent", "a"], env).code, 0);
});

test("agents-md command installs layer 1 and is idempotent", () => {
  const { env } = machine();
  const project = path.join(env.HOME, "project");
  mkdirSync(project, { recursive: true });
  const file = path.join(project, "AGENTS.md");
  const skills = path.join(env.HOME, "fallback-skills");
  const args = ["install", "agents-md", "--overlay", path.join(env.HOME, "problems"), "--agent", "a", "--file", file, "--skills-dir", skills];
  const first = aps(args, env);
  assert.equal(first.code, 0, first.err);
  assert.ok(existsSync(path.join(env.HOME, ".local", "bin", "aps")));
  assert.deepEqual(readdirSync(skills).sort(), ["close-problem", "focus", "frame-problem", "reframe"]);
  assert.match(read(file), /problems\/agents\/a\/PROBLEMS\.md/);
  const before = read(file);
  const second = aps(args, env);
  assert.equal(second.code, 0, second.err);
  assert.equal(read(file), before);
});

test("moving the pack replaces its own old hook and skill links", () => {
  const a = path.join(home(), "clone-a");
  const b = path.join(home(), "clone-b");
  require("node:fs").cpSync(CORE, a, { recursive: true });
  require("node:fs").cpSync(CORE, b, { recursive: true });
  const dir = home();
  installClaudeCode({ core: a, configDir: dir });
  const r = installClaudeCode({ core: b, configDir: dir });
  assert.equal(r.ok, true, r.reason);
  const commands = json(path.join(dir, "settings.json")).hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(commands.filter((c) => c.includes("reminder.mjs")).length, 1);
  assert.ok(commands[0].includes("clone-b"));
  assert.equal(require("node:fs").readlinkSync(path.join(dir, "skills", "focus")), path.join(b, "skills", "focus"));
});

// -------------------------------------------- the command finds its own setup

test("every command works off the settings install wrote, with no flags", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const ov = path.join(env.HOME, "problems");
  aps(["install", "claude-code", "--overlay", ov, "--agent", "a", "--all-projects"], env);
  const register = path.join(ov, "agents", "a", "PROBLEMS.md");
  writeFileSync(register, read(register).replace("Mission:", "Mission: ship the current project"));
  for (const cmd of [["lint"], ["report"], ["doctor"]]) {
    const r = aps(cmd, env);
    assert.equal(r.code, 0, `aps ${cmd.join(" ")}: ${r.out}\n${r.err}`);
  }
  const r = aps(["set", "P1", "status=parked"], env);
  // No P1 yet in a template register, but it must fail on the problem id, not
  // on "no overlay": the block tells the agent to run it with no flags.
  assert.doesNotMatch(r.err, /no overlay/);
});

// ------------------------------------------- where the registry is stored

import { overlayChoices, pickOverlay, DEFAULT_AGENT_ID } from "../lib/install.js";

test("inside a repository the first place offered is that repository", () => {
  const { env } = machine();
  const repo = path.join(env.HOME, "code", "site");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  const choices = overlayChoices({ targets: ["claude-code"], cwd: path.join(repo, "src"), env });
  assert.equal(choices[0].path, path.join(repo, ".problems"));
  assert.equal(choices[1].path, path.join(env.CLAUDE_CONFIG_DIR, "problems"));
});

test("each runtime offers its own home, and none offers a bare home-directory folder", () => {
  const { env } = machine();
  const cwd = mkdtempSync(path.join(tmpdir(), "aps-norepo-"));
  writeFileSync(path.join(env.HOME, "unused"), "");
  mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"), JSON.stringify({ agents: { defaults: { workspace: path.join(env.HOME, "ws") } } }));
  const paths = (targets) => overlayChoices({ targets, cwd, env }).map((c) => c.path);
  assert.deepEqual(paths(["codex"]), [path.join(env.CODEX_HOME, "problems")]);
  assert.deepEqual(paths(["openclaw"]), [path.join(env.HOME, "ws", "problems")]);
  assert.deepEqual(paths(["claude-code", "codex"]), [path.join(env.CLAUDE_CONFIG_DIR, "problems"), path.join(env.CODEX_HOME, "problems")]);
  for (const t of ["claude-code", "codex", "openclaw", "agents-md"]) {
    assert.ok(!paths([t]).includes(path.join(env.HOME, "problems")), t);
  }
});

test("an OpenClaw config with no workspace falls back to the gateway's default workspace", () => {
  const { env } = machine();
  const cwd = mkdtempSync(path.join(tmpdir(), "aps-norepo-"));
  const choices = overlayChoices({ targets: ["openclaw"], cwd, env });
  assert.deepEqual(choices.map((c) => c.path), [path.join(env.OPENCLAW_STATE_DIR, "workspace", "problems")]);
});

test("an answer picks a numbered place, or names one of its own", () => {
  const choices = [{ path: "/r/.problems" }, { path: "/h/.claude/problems" }];
  assert.equal(pickOverlay("", choices, { cwd: "/w", home: "/h" }), "/r/.problems");
  assert.equal(pickOverlay("2", choices, { cwd: "/w", home: "/h" }), "/h/.claude/problems");
  assert.equal(pickOverlay("3", choices, { cwd: "/w", home: "/h" }), null);
  assert.equal(pickOverlay("~/notes/problems", choices, { cwd: "/w", home: "/h" }), "/h/notes/problems");
  assert.equal(pickOverlay("docs/problems", choices, { cwd: "/w", home: "/h" }), "/w/docs/problems");
});

test("with no --overlay and nobody to ask, install lists the places and writes nothing", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const r = aps(["install", "claude-code"], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /--overlay/);
  assert.ok(r.err.includes(path.join(env.CLAUDE_CONFIG_DIR, "problems")), r.err);
  assert.equal(existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);
});

test("--yes takes the first place offered: the repository the install runs in", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const repo = path.join(env.HOME, "site");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const r = spawnSync(process.execPath, [APS, "install", "claude-code", "--yes"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, APS_OVERLAY: "", APS_AGENT: "", ...env },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(json(path.join(env.APS_CONFIG_HOME, "config.json")).overlayPath, path.join(repo, ".problems"));
  assert.ok(existsSync(path.join(repo, ".problems", "agents", DEFAULT_AGENT_ID, "PROBLEMS.md")));
});

test("a relative --overlay is read against the directory the install runs in", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const proj = path.join(env.HOME, "proj");
  mkdirSync(proj, { recursive: true });
  const r = spawnSync(process.execPath, [APS, "install", "claude-code", "--overlay", ".problems"], {
    cwd: proj,
    encoding: "utf8",
    env: { ...process.env, APS_OVERLAY: "", APS_AGENT: "", ...env },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(json(path.join(env.APS_CONFIG_HOME, "config.json")).overlayPath, path.join(proj, ".problems"));
});

test("with no named agent the register goes under a neutral default, and no agent is recorded", () => {
  const { env } = machine();
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const ov = path.join(env.HOME, "store");
  const r = aps(["install", "claude-code", "--overlay", ov, "--all-projects"], env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.equal(DEFAULT_AGENT_ID, "default");
  assert.ok(existsSync(path.join(ov, "agents", "default", "PROBLEMS.md")));
  assert.equal(json(path.join(env.APS_CONFIG_HOME, "config.json")).agentId, undefined);
});

test("OpenClaw with no --agents gets a register for the agent it routes to by default", () => {
  const { env } = machine();
  mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "helper" }, { id: "lead", default: true }] } }));
  const ov = path.join(env.HOME, "store");
  const r = aps(["install", "openclaw", "--overlay", ov], env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.deepEqual(readdirSync(path.join(ov, "agents")), ["lead"]);
});
