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
