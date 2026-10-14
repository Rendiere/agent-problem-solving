import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gaugeLine, gaugeBand, DEFAULT_WARN_TOKENS, DEFAULT_HIGH_TOKENS } from "../lib/gauge.js";

test("below the warning level the gauge shows the count only", () => {
  assert.equal(gaugeLine(120_000), "Context: 120k tokens.");
  assert.equal(gaugeBand(120_000), "ok");
});

test("past the warning level it offers a reset at the next boundary", () => {
  const t = gaugeLine(260_000);
  assert.match(t, /^Context: 260k tokens\./);
  assert.match(t, /Past the 250k level/);
  assert.match(t, /at the next close, park or reframe/);
  assert.match(t, /Not mid-problem/);
  assert.match(t, /pending: reset/);
  assert.equal(gaugeBand(260_000), "warn");
});

test("past the high level it writes state and offers straight away", () => {
  const t = gaugeLine(510_000);
  assert.match(t, /Past the 500k level/);
  assert.match(t, /straight away even mid-problem/);
  assert.doesNotMatch(t, /Not mid-problem/);
  assert.equal(gaugeBand(510_000), "high");
});

test("no figure shows unknown", () => {
  assert.match(gaugeLine(null), /^Context: unknown/);
  assert.equal(gaugeBand(null), "unknown");
});

test("a stale figure says so", () => {
  assert.match(gaugeLine({ tokens: 50_000, fresh: false }), /last known/);
});

test("the gauge shows no percentage and names no ceiling", () => {
  for (const n of [1_000, 120_000, 260_000, 510_000]) {
    const t = gaugeLine(n);
    assert.doesNotMatch(t, /%/, t);
    assert.doesNotMatch(t, /ceiling|target of|out of/i, t);
  }
});

test("a compact is only offered where compacting shrinks the session", () => {
  assert.doesNotMatch(gaugeLine(260_000), /compact/i);
  assert.match(gaugeLine(260_000, { compactShrinksSession: true }), /compact/i);
});

test("the levels are configurable and the reset command is named", () => {
  const t = gaugeLine(31_000, { warnTokens: 30_000, highTokens: 60_000, resetCommand: "/reset" });
  assert.match(t, /Past the 30k level/);
  assert.match(t, /\/reset to start fresh/);
});

test("the defaults are the two levels the plan names", () => {
  assert.equal(DEFAULT_WARN_TOKENS, 250_000);
  assert.equal(DEFAULT_HIGH_TOKENS, 500_000);
});

test("no string in the core still assumes a 200k ceiling or a ceilingTokens option", () => {
  const roots = ["lib", "bin", "skills", "templates", "docs"];
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.(js|mjs|md|json|json5)$/.test(e.name)) {
        const text = readFileSync(new URL(`../${dir}/${e.name}`, import.meta.url), "utf8");
        // The spike record quotes what was observed; it is history, not config.
        if (`${dir}/${e.name}`.startsWith("docs/")) continue;
        if (/ceilingTokens/.test(text)) hits.push(`${dir}/${e.name}: ceilingTokens`);
        if (/200k (?:target|ceiling)/.test(text)) hits.push(`${dir}/${e.name}: 200k ceiling`);
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(hits, []);
});

test("ceilingTokens is not in the config schema", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const props = Object.keys(manifest.configSchema.properties);
  assert.ok(!props.includes("ceilingTokens"));
  assert.ok(props.includes("warnTokens") && props.includes("highTokens"));
  assert.equal(manifest.configSchema.additionalProperties, false);
});
