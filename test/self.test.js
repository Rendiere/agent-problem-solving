import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apsBin, hookScript, templateRegister, apsCommand, shellArg } from "../lib/self.js";
import { today } from "../lib/gauge.js";

test("every path this package prints about itself exists", () => {
  for (const f of [apsBin(), hookScript(), templateRegister()]) assert.ok(existsSync(f), f);
});

test("every runtime manifest parses and the portable hook path exists", () => {
  const root = path.dirname(path.dirname(apsBin()));
  const files = [
    "plugin.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "openclaw.plugin.json",
    "hooks/hooks.json",
  ];
  for (const name of files) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(root, name), "utf8")), name);
  }
  const portable = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(portable.extensions["com.openai"].hooks, "./hooks/hooks.json");
  assert.ok(existsSync(path.join(root, portable.extensions["com.openai"].hooks)));
});

test("a path with a space survives, because it is not a URL path", () => {
  assert.doesNotMatch(apsBin(), /%2[0F]/);
  assert.equal(shellArg("/tmp/My Code/core"), "'/tmp/My Code/core'");
  assert.equal(shellArg("/tmp/plain/core"), "/tmp/plain/core");
  // POSIX single-quote escaping: close, escape the quote, reopen.
  assert.equal(shellArg("it's here"), "'it'\\''s here'");
  const r = spawnSync("sh", ["-c", `printf %s ${shellArg("it's here")}`], { encoding: "utf8" });
  assert.equal(r.stdout, "it's here");
});

// The reminder tells the agent to run this command on every turn, so the test
// runs it. A command that only looks right is the bug this replaces.
test("the command the reminder prints actually changes the register", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-self-"));
  mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
  const file = path.join(dir, "agents", "a", "PROBLEMS.md");
  writeFileSync(file, `Mission: x\n\n## P1. Fix the thing\n- status: active\n- thread: dir:p\n- done when: it passes\n- confirmed: ${today()} active\n- updated: ${today()}\n`);

  const printed = apsCommand({ overlay: dir, agentId: "a" });
  const real = printed.replace("set <ID> field=value", "set P1 status=parked state=waiting");
  const r = spawnSync("sh", ["-c", real], { encoding: "utf8" });
  assert.equal(r.status, 0, `${printed}\n${r.stdout}\n${r.stderr}`);
  assert.match(readFileSync(file, "utf8"), /status: parked/);
});
