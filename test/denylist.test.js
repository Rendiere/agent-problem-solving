import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDenylist, scanForDenied } from "../lib/denylist.js";
import { denylistPath } from "../lib/paths.js";

const CORE = (await import("../lib/self.js")).packageRoot();

function fakeCore(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-deny-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("a core file holding a listed identifier fails, with the file and line", () => {
  const dir = fakeCore({ "lib/x.js": "const a = 1;\n// trial agents: topic:1234\n" });
  const hits = scanForDenied(dir, ["topic:1234", "Someone"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "lib/x.js");
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].term, "topic:1234");
});

test("a clean core passes, and a longer word is not a match", () => {
  const dir = fakeCore({ "lib/x.js": "const zetatrope = fetch('/x');\n", "README.md": "# core\n" });
  assert.deepEqual(scanForDenied(dir, ["zeta", "topic:1234"]), []);
});

test("a listed name inside a hyphenated compound is still a match", () => {
  const dir = fakeCore({
    "test/x.test.js": 'const id = "zeta-2";\nconst repo = "zeta-agent";\nconst other = "agent-zeta";\n',
  });
  assert.deepEqual(scanForDenied(dir, ["zeta"]).map((h) => h.line), [1, 2, 3]);
});

test("a name in a log, a file with no extension or an unfamiliar type is caught", () => {
  const dir = fakeCore({
    "fixtures/decisions.jsonl": '{"agent":"zeta","thread":"topic:1234"}\n',
    LICENSE: "Copyright (c) Zeta\n",
    "lib/x.ts": "const a: string = 'zeta';\n",
  });
  const hits = scanForDenied(dir, ["zeta", "topic:1234"]);
  assert.deepEqual(
    [...new Set(hits.map((h) => h.file))].sort(),
    ["LICENSE", "fixtures/decisions.jsonl", "lib/x.ts"],
  );
});

test("a binary file is skipped rather than scanned as text", () => {
  const dir = mkdtempSync(path.join(tmp(), "aps-bin-"));
  writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x7a, 0x65, 0x74, 0x61]));
  assert.deepEqual(scanForDenied(dir, ["zeta"]), []);
});

test("an overlay with no deny-list is an error, not a pass", () => {
  const empty = mkdtempSync(path.join(tmp(), "aps-nolist-"));
  assert.throws(() => readDenylist(denylistPath(empty)), { code: "ENOENT" });
});

test("this core is clean against the operator's deny-list, when there is one", (t) => {
  const overlay = process.env.APS_OVERLAY;
  if (!overlay) {
    // The public repository ships no list, so there is nothing to check here.
    // The operator's pre-commit hook runs this test with APS_OVERLAY set.
    t.skip("no APS_OVERLAY: nothing to check");
    return;
  }
  const file = denylistPath(overlay);
  let terms;
  try {
    terms = readDenylist(file);
  } catch (err) {
    assert.fail(`APS_OVERLAY is set but its deny-list is unreadable (${file}): ${err.message}`);
  }
  assert.ok(terms.terms.length, `the deny-list at ${file} is empty`);
  const hits = scanForDenied(CORE, terms);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} "${h.term}" — ${h.text}`),
    [],
  );
});

test("an allowed phrase lets one public use of a listed name through, and only that one", () => {
  const dir = fakeCore({
    "README.md": "npx skills add zeta/problems\n",
    "lib/x.js": 'const owner = "zeta";\n',
  });
  const hits = scanForDenied(dir, ["zeta"], ["zeta/problems"]);
  assert.deepEqual(hits.map((h) => [h.file, h.line]), [["lib/x.js", 1]]);
});

test("two names on one line, one of them allowed, still fails on the other", () => {
  const dir = fakeCore({ "README.md": "zeta/problems, by zeta and omega\n" });
  const hits = scanForDenied(dir, ["zeta", "omega"], ["zeta/problems"]);
  // "zeta" appears again outside the allowed phrase, so both still trip.
  assert.deepEqual(hits.map((h) => h.term).sort(), ["omega", "zeta"]);
});

test("the deny-list file separates allowed phrases from listed names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aps-deny-list-"));
  writeFileSync(path.join(dir, "denylist.txt"), "# names\nzeta\nomega\n\nallow: zeta/problems\nallow: github.com/zeta\n");
  const list = readDenylist(path.join(dir, "denylist.txt"));
  assert.deepEqual(list.terms, ["zeta", "omega"]);
  assert.deepEqual(list.allowed, ["zeta/problems", "github.com/zeta"]);
});

test("a longer slug that merely starts with an allowed phrase is not allowed", () => {
  const dir = fakeCore({ "README.md": "see github.com/zeta/problems-overlay for my private registers\n" });
  const hits = scanForDenied(dir, ["zeta"], ["zeta/problems"]);
  assert.deepEqual(hits.map((h) => h.term), ["zeta"]);
});

test("a character that changes length when lowercased cannot shift the blanking", () => {
  // "İ" lowercases to two code units, so an offset taken from a lowercased copy
  // lands to the right of the real match and erases what follows it.
  const dir = fakeCore({ "x.md": `${"İ".repeat(8)} zeta/problems zeta\n` });
  assert.deepEqual(scanForDenied(dir, ["zeta"], ["zeta/problems"]).map((h) => h.term), ["zeta"]);
});
