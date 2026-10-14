// The reminder hook on a command-line runtime (U12). Claude Code and Codex both
// run a UserPromptSubmit hook that reads one JSON object on stdin and honours
// `hookSpecificOutput.additionalContext` on stdout, so one script serves both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { today } from "../lib/gauge.js";
import { threadForCli, agentForCli } from "../adapters/cli/runtime.js";
import { claimTurn } from "../lib/settings.js";

const HOOK = fileURLToPath(new URL("../hooks/reminder.mjs", import.meta.url));
const DAY = today();

const active = (thread) =>
  `Mission: ten artists on the platform\n\n## P1. Fix the thing\n- status: active\n- thread: ${thread}\n- problem: the check fails on every run\n- done when: the check passes\n- confirmed: ${DAY} active\n- updated: ${DAY}\n`;

const ACTIVE = active("dir:anywhere");

/** A project directory paired with an overlay whose problem lives in it. */
function pair(name = "project", { agent = "a", edit = (s) => s } = {}) {
  const cwd = project(name);
  return { cwd, dir: overlay(edit(active(threadForCli(cwd))), agent) };
}

function overlay(text = ACTIVE, agent = "a") {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-cli-"));
  mkdirSync(path.join(dir, "agents", agent), { recursive: true });
  if (text !== null) writeFileSync(path.join(dir, "agents", agent, "PROBLEMS.md"), text);
  return dir;
}

function project(name = "project") {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-proj-"));
  const cwd = path.join(dir, name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

// The suite itself runs inside an agent, so the ambient environment already
// says "automated" and "OpenClaw owns this turn". Each test states what it
// wants instead of inheriting the one it happens to run under.
const BARE = Object.fromEntries(
  Object.keys(process.env)
    .filter((k) => /^(APS_|CLAUDE_CODE_|OPENCLAW_)/.test(k))
    .map((k) => [k, ""]),
);

const INTERACTIVE = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" };

/** Run the hook the way a runtime runs it: JSON in on stdin, JSON out. */
function run(event, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, ...BARE, ...INTERACTIVE, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const context = (out) => {
  if (!out.trim()) return "";
  return JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
};

// A real Claude Code UserPromptSubmit event, trimmed to the documented fields.
const claudeEvent = (cwd) => ({
  session_id: "5e9a1f3c-0000-4000-8000-000000000001",
  transcript_path: "/tmp/transcript.jsonl",
  cwd,
  hook_event_name: "UserPromptSubmit",
  permission_mode: "default",
  prompt: "can you look at the privacy page",
});

// A real Codex UserPromptSubmit event: same shape plus turn_id and model.
const codexEvent = (cwd) => ({ ...claudeEvent(cwd), turn_id: "turn_7", model: "gpt-5.3-codex" });

test("the hook names the active problem and its done-when on a Claude Code turn", () => {
  const { cwd, dir } = pair();
  const r = run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a" });
  assert.equal(r.code, 0, r.stderr);
  const text = context(r.stdout);
  assert.match(text, /P1 Fix the thing/);
  assert.match(text, /Done when: the check passes/);
  assert.match(text, /Mission: ten artists/);
});

test("a Codex turn gets the same block", () => {
  const { cwd, dir } = pair("both-runtimes");
  const claude = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  const codexDir = overlay(active(threadForCli(cwd)));
  const codex = context(run(codexEvent(cwd), { APS_OVERLAY: codexDir, APS_AGENT: "a" }).stdout)
    .replaceAll(codexDir, dir);
  assert.equal(codex, claude);
});

test("a new command-line session opens by naming the problem it is back on", () => {
  const { cwd, dir } = pair("back-on");
  const env = { APS_OVERLAY: dir, APS_AGENT: "a" };
  const first = context(run({ ...claudeEvent(cwd), session_id: "session-one" }, env).stdout);
  const same = context(run({ ...claudeEvent(cwd), session_id: "session-one" }, env).stdout);
  const next = context(run({ ...claudeEvent(cwd), session_id: "session-two" }, env).stdout);
  assert.match(first, /First turn of this session: open your reply with "Back on:/);
  assert.doesNotMatch(same, /First turn of this session/);
  assert.match(next, /First turn of this session: open your reply with "Back on:/);
  const firstAgain = context(run({ ...claudeEvent(cwd), session_id: "session-one", prompt: "another turn" }, env).stdout);
  assert.doesNotMatch(firstAgain, /First turn of this session/);
});

test("the command-line hook logs a hand edit on the next turn", () => {
  const { cwd, dir } = pair("hand-edit");
  const env = { APS_OVERLAY: dir, APS_AGENT: "a" };
  run({ ...claudeEvent(cwd), session_id: "one" }, env);
  const file = path.join(dir, "agents", "a", "PROBLEMS.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("- status: active", "- status: parked"));
  run({ ...claudeEvent(cwd), session_id: "one" }, env);
  const rows = readFileSync(path.join(dir, "agents", "a", "decisions.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "hand-edit");
  assert.equal(rows[0].kind, "parked");
});

test("the event names the right hook, so the runtime accepts the output", () => {
  const { cwd, dir } = pair("hook-name");
  const r = run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a" });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("an open question becomes a stop line, so it survives a restart", () => {
  const { cwd, dir } = pair("pending-case", { edit: (s) => s.replace("- updated:", `- pending: drift ${DAY}\n- updated:`) });
  const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  assert.match(text, /STOP: waiting for the answer to the drift notice on P1/);
});

test("the gauge is left out where the runtime reports no token count", () => {
  const { cwd, dir } = pair("no-gauge");
  const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  assert.doesNotMatch(text, /Context:/);
});

test("the thread is the project, so it survives a new session", () => {
  assert.equal(threadForCli(""), null);
  // A different session id in the same directory is the same thread.
  const cwd = project("privacy-page");
  const dir = overlay();
  const a = context(run({ ...claudeEvent(cwd), session_id: "aaa" }, { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  const b = context(run({ ...claudeEvent(cwd), session_id: "bbb" }, { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  assert.equal(a.replace("--session aaa", "--session SESSION"), b.replace("--session bbb", "--session SESSION"));
  assert.match(a, new RegExp(`Thread ${threadForCli(cwd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("one agent in the overlay needs no agent id", () => {
  const { cwd, dir } = pair("single-agent", { agent: "only" });
  assert.equal(agentForCli(dir, {}), "only");
  assert.match(context(run(claudeEvent(cwd), { APS_OVERLAY: dir }).stdout), /P1 Fix the thing/);
});

test("two agents and no agent id is a degraded notice, not a silent wrong register", () => {
  const dir = overlay(ACTIVE, "one");
  mkdirSync(path.join(dir, "agents", "two"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "two", "PROBLEMS.md"), ACTIVE);
  const text = context(run(claudeEvent(project()), { APS_OVERLAY: dir }).stdout);
  assert.match(text, /2 agents/);
});

test("settings on disk supply the overlay, so a person sets nothing up by hand", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-cfg-"));
  const { cwd, dir } = pair("from-settings");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ overlayPath: dir, agentId: "a" }));
  assert.match(context(run(claudeEvent(cwd), { APS_CONFIG_HOME: home }).stdout), /P1 Fix the thing/);
});

test("the environment wins over settings on disk", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-cfg-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ overlayPath: "/nowhere", agentId: "a" }));
  const { cwd, dir } = pair("env-wins");
  assert.match(context(run(claudeEvent(cwd), { APS_CONFIG_HOME: home, APS_OVERLAY: dir, APS_AGENT: "a" }).stdout), /P1 Fix the thing/);
});

test("a native plugin install with no overlay says how to finish setup", () => {
  const r = run(claudeEvent(project()));
  assert.equal(r.code, 0);
  assert.match(context(r.stdout), /installed but not set up/);
  assert.match(context(r.stdout), /install claude-code/);
  assert.doesNotMatch(context(r.stdout), /~\/problems|--agent me/);
});

test("a malformed event exits clean and silent", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json at all", encoding: "utf8", env: { ...process.env, ...BARE, ...INTERACTIVE, APS_OVERLAY: overlay(), APS_AGENT: "a" } });
  assert.equal(r.status, 0);
  assert.equal((r.stdout ?? "").trim(), "");
});

test("an unreadable register says so rather than reporting no problem", (t) => {
  if (process.geteuid?.() === 0) {
    t.skip("root can read a 000 file");
    return;
  }
  const dir = overlay();
  const file = path.join(dir, "agents", "a", "PROBLEMS.md");
  chmodSync(file, 0o000);
  const text = context(run(claudeEvent(project()), { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  chmodSync(file, 0o644);
  assert.match(text, /register unreadable/);
  assert.doesNotMatch(text, /no problem\./);
});

test("an overlay path that is missing is reported, not treated as an empty overlay", () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), "aps-missing-parent-")), "missing");
  const text = context(run(claudeEvent(project()), { APS_OVERLAY: missing, APS_AGENT: "a" }).stdout);
  assert.match(text, /no overlay directory/);
});

test("an agent with no register is told how to start one", () => {
  const text = context(run(claudeEvent(project()), { APS_OVERLAY: overlay(null), APS_AGENT: "a" }).stdout);
  assert.match(text, /No register at/);
  assert.match(text, /frame-problem/);
});

test("the command the block carries actually changes the register", () => {
  const { cwd, dir } = pair("printed-command");
  const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout);
  const printed = text.split("\n").find((l) => l.startsWith("Change it: "))?.slice("Change it: ".length);
  assert.ok(printed, text);
  assert.ok(printed.includes(dir), printed);
  const r = spawnSync("sh", ["-c", printed.replace("set <ID> field=value", "set P1 status=parked state=waiting")], { encoding: "utf8" });
  assert.equal(r.status, 0, `${printed}\n${r.stdout}\n${r.stderr}`);
  assert.match(readFileSync(path.join(dir, "agents", "a", "PROBLEMS.md"), "utf8"), /status: parked/);
});

// ------------------------------------------------- the hook minds its own work

test("the hook says nothing in a directory the person has not opted in", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-cfg-"));
  const mine = project("mine");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ overlayPath: overlay(active(threadForCli(mine))), agentId: "a", projects: [mine] }));
  assert.match(context(run({ ...claudeEvent(mine), cwd: mine }, { APS_CONFIG_HOME: home }).stdout), /P1 Fix the thing/);
  // Someone else's repo, an employer's checkout, another agent's workspace.
  const theirs = project("theirs");
  assert.equal(run({ ...claudeEvent(theirs), cwd: theirs }, { APS_CONFIG_HOME: home }).stdout.trim(), "");
});

test("a directory inside an opted-in project counts as that project", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-cfg-"));
  const root = project("mine");
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ overlayPath: overlay(active(threadForCli(root))), agentId: "a", projects: [root] }));
  const text = context(run({ ...claudeEvent(root), cwd: path.join(root, "src", "deep") }, { APS_CONFIG_HOME: home }).stdout);
  assert.match(text, /P1 Fix the thing/);
  // A sibling whose name merely starts the same is not inside it.
  const sibling = `${root}-other`;
  mkdirSync(sibling, { recursive: true });
  assert.equal(run({ ...claudeEvent(sibling), cwd: sibling }, { APS_CONFIG_HOME: home }).stdout.trim(), "");
});

test("no projects listed means every directory, so an existing install keeps working", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-cfg-"));
  const { cwd, dir } = pair("unlisted");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ overlayPath: dir, agentId: "a" }));
  assert.match(context(run(claudeEvent(cwd), { APS_CONFIG_HOME: home }).stdout), /P1 Fix the thing/);
});

test("a turn nobody is attending is marked automated, so it asks nothing", () => {
  const { cwd, dir } = pair("unattended");
  const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a", CLAUDE_CODE_SESSION_ATTENDED: "0" }).stdout);
  assert.match(text, /Automated turn/);
  assert.doesNotMatch(text, /Check: does this reply move the done-when/);
});

test("a scripted run is automated even when it says nothing about attendance", () => {
  const { cwd, dir } = pair("scripted");
  const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "" }).stdout);
  assert.match(text, /Automated turn/);
});

test("real Claude IDE and desktop entrypoints are person turns", () => {
  for (const entry of ["claude-vscode", "claude-desktop", "claude-desktop-3p"]) {
    const { cwd, dir } = pair(entry);
    const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a", CLAUDE_CODE_ENTRYPOINT: entry, CLAUDE_CODE_SESSION_ATTENDED: "1" }).stdout);
    assert.doesNotMatch(text, /Automated turn/, entry);
    assert.match(text, /Check: does this reply move the done-when/, entry);
  }
});

test("a bare confirmed command during an automated session is flagged", () => {
  const { cwd, dir } = pair("automated-confirm");
  run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" });
  const aps = fileURLToPath(new URL("../bin/aps.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [aps, "set", "P1", "status=done", "--confirmed", "--overlay", dir, "--agent", "a"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, APS_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), "aps-cfg-")) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /flagged: confirmed during an automated turn/);
});

test("two hook copies claim one prompt only", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-claim-"));
  const event = { session_id: "same", prompt: "same prompt" };
  assert.equal(claimTurn(event, { APS_CONFIG_HOME: home }), true);
  assert.equal(claimTurn(event, { APS_CONFIG_HOME: home }), false);
});

test("an interactive run is the person's turn", () => {
  const { cwd, dir } = pair("interactive-case");
  const text = context(run(claudeEvent(cwd), { APS_OVERLAY: dir, APS_AGENT: "a", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" }).stdout);
  assert.doesNotMatch(text, /Automated turn/);
  assert.match(text, /Check: does this reply move the done-when/);
});

test("a turn OpenClaw started is left to OpenClaw's own adapter", () => {
  const dir = overlay();
  // Two blocks on one turn, one of them with the wrong thread, is worse than one.
  const r = run(claudeEvent(project()), { APS_OVERLAY: dir, APS_AGENT: "a", OPENCLAW_MCP_SESSION_KEY: "agent:other:telegram:group:-1:topic:9" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("the thread is the project root written out in full, so two projects cannot collide", () => {
  // Two unrelated checkouts with the same last segment.
  const { cwd: a, dir } = pair("api");
  const b = project("api");
  assert.notEqual(threadForCli(a), threadForCli(b));
  assert.match(context(run({ ...claudeEvent(a), cwd: a }, { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout), /on P1 Fix the thing/);
  assert.match(context(run({ ...claudeEvent(b), cwd: b }, { APS_OVERLAY: dir, APS_AGENT: "a" }).stdout), /no problem\./);
});

test("a subfolder of a project is the same thread as its root", () => {
  const root = project("website");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  assert.equal(threadForCli(path.join(root, "src")), threadForCli(root));
});

test("a home-relative thread is written with a tilde, so it is readable and portable", () => {
  const home = mkdtempSync(path.join(tmpdir(), "aps-home-"));
  mkdirSync(path.join(home, "code", "website"), { recursive: true });
  assert.equal(threadForCli(path.join(home, "code", "website"), { HOME: home }), "dir:~/code/website");
});
