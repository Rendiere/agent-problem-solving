import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../skills/frame-problem/SKILL.md", import.meta.url), "utf8");

test("the confirmation template is scannable in Telegram", () => {
  for (const heading of ["🎯 **Problem**", "🧭 **Serves**", "✅ **Done when**", "🚧 **Out of scope**", "💡 **Approach**"]) {
    assert.match(skill, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(skill, /> _<problem>_/);
  assert.match(skill, /- \[ \] <check one>\n\s+- \[ \] <check two>/);
});

test("approval registers before a required delivery pin", () => {
  const register = skill.indexOf("**On approval, register first.**");
  const send = skill.indexOf("**Send and pin the commitment.**");
  assert.ok(register >= 0 && send > register);
  assert.match(skill, /I am committing to solve this problem in this topic/);
  assert.match(skill, /delivery: \{ pin: \{ enabled: true, required: true \} \}/);
  assert.match(skill, /The problem is registered, but pinning failed:/);
  assert.match(skill, /Never claim it is pinned without a successful tool result/);
});

const closeSkill = readFileSync(new URL("../skills/close-problem/SKILL.md", import.meta.url), "utf8");

test("the close-problem skill covers the once-a-day check", () => {
  // Raised by the reminder, so the skill has to say what to do when it arrives.
  assert.match(closeSkill, /Close-check/);
  // Evidence the agent can reach without the operator doing anything.
  for (const source of ["register", "thread", "repository"]) {
    assert.match(closeSkill, new RegExp(source, "i"), `no mention of ${source}`);
  }
  // Drop covers a problem that stopped mattering, which is not the same as done.
  assert.match(closeSkill, /1\. Done 2\. Drop 3\. Keep open/);
  assert.match(closeSkill, /status=dropped/);
  assert.match(closeSkill, /no longer/i);
  // Still open is a silent outcome: the daily check must not become a daily nag.
  assert.match(closeSkill, /say nothing/i);
});

test("the close-problem skill never closes a problem on its own", () => {
  assert.match(closeSkill, /--confirmed/);
  assert.match(closeSkill, /without their yes|only the operator|Nothing closes/i);
});
