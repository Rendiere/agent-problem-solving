import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCore, scan, readDenylist } from "../lib/denylist.js";

const CORE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function fakeOverlay(list) {
  const root = mkdtempSync(path.join(tmpdir(), "aps-dl-"));
  if (list !== null) writeFileSync(path.join(root, "denylist.txt"), list);
  return root;
}

function fakeCore(files) {
  const root = mkdtempSync(path.join(tmpdir(), "aps-core-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("a core file holding a listed topic id fails, naming the file and line", async () => {
  const core = fakeCore({ "lib/x.js": "// ok\nconst t = 'topic:4242';\n" });
  const r = await checkCore(core, fakeOverlay("topic:4242\n"));
  assert.equal(r.status, "failed");
  assert.deepEqual(r.hits.map((h) => [h.file, h.line, h.term]), [["lib/x.js", 2, "topic:4242"]]);
});

test("a core file holding a listed name fails", async () => {
  const core = fakeCore({ "skills/a/SKILL.md": "Ask Rowan to confirm.\n" });
  const r = await checkCore(core, fakeOverlay("Rowan\nAgentBeta\n"));
  assert.equal(r.status, "failed");
  assert.equal(r.hits[0].term, "Rowan");
});

test("a listed name does not match inside another word", async () => {
  const core = fakeCore({ "lib/x.js": "const render = 1; // renew, rendered\n" });
  assert.equal((await checkCore(core, fakeOverlay("Rowan\n"))).status, "passed");
});

test("a clean core passes", async () => {
  const core = fakeCore({ "lib/x.js": "export const x = 1;\n", "README.md": "# Core\n" });
  const r = await checkCore(core, fakeOverlay("Rowan\ntopic:4242\n-1000000000000\n"));
  assert.deepEqual([r.status, r.hits], ["passed", []]);
});

test("with no overlay the check is skipped and says so", async () => {
  const r = await checkCore(fakeCore({ "a.js": "x" }), "");
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /no deny-list/);
});

test("an overlay with no deny-list file fails", async () => {
  const r = await checkCore(fakeCore({ "a.js": "x" }), fakeOverlay(null));
  assert.equal(r.status, "failed");
  assert.match(r.reason, /is missing/);
});

test("an empty deny-list fails rather than passing by accident", async () => {
  const r = await checkCore(fakeCore({ "a.js": "x" }), fakeOverlay("# just a comment\n\n"));
  assert.equal(r.status, "failed");
  assert.match(r.reason, /is empty/);
});

test("comments and blank lines are not terms", async () => {
  const root = fakeOverlay("# names\nRowan\n\n  topic:4242  # a test topic\n");
  assert.deepEqual(await readDenylist(path.join(root, "denylist.txt")), ["Rowan", "topic:4242"]);
});

test("binaries, node_modules and the state dir are not scanned", async () => {
  const core = fakeCore({
    "node_modules/p/index.js": "Rowan\n",
    ".state/a.snapshot.json": "Rowan\n",
    "a.png": Buffer.from([0, 82, 111, 119, 97, 110]),
    "ok.js": "clean\n",
  });
  assert.equal((await checkCore(core, fakeOverlay("Rowan\n"))).status, "passed");
});

test("extensionless and unfamiliar text files are scanned", async () => {
  const core = fakeCore({ "LICENSE": "Rowan\n", "fixture.jsonl": '{"agent":"Rowan"}\n' });
  const r = await checkCore(core, fakeOverlay("Rowan\n"));
  assert.equal(r.status, "failed");
  assert.deepEqual(r.hits.map((h) => h.file).sort(), ["LICENSE", "fixture.jsonl"]);
});

test("this core passes against the operator's deny-list when one is present", async () => {
  const r = await checkCore(CORE, process.env.APS_OVERLAY ?? "");
  assert.notEqual(r.status, "failed", `${r.reason}\n${(r.hits ?? []).map((h) => `${h.file}:${h.line} ${h.term} — ${h.text}`).join("\n")}`);
});
