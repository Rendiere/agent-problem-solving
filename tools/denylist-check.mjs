#!/usr/bin/env node
// Run a deny-list over this package, or over just what is staged.
//
//   APS_OVERLAY=… node tools/denylist-check.mjs            the whole package
//   APS_OVERLAY=… node tools/denylist-check.mjs --staged    what is about to commit
//
// The staged check reads the blobs from the index, not the working tree: staging
// a file with a listed name and then fixing the working copy without restaging
// would otherwise commit the name.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readDenylist, scanForDenied } from "../lib/denylist.js";
import { denylistPath } from "../lib/paths.js";

const core = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const overlay = process.env.APS_OVERLAY ?? "";
const staged = process.argv.includes("--staged");

if (!overlay) {
  process.stderr.write("deny-list: APS_OVERLAY is not set, so there is no list to check against.\n");
  process.exit(1);
}

const list = readDenylist(denylistPath(overlay));
let hits;

if (staged) {
  const names = execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], { cwd: core, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!names.length) {
    process.stdout.write("deny-list: nothing staged.\n");
    process.exit(0);
  }
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const work = mkdtempSync(path.join(tmpdir(), "aps-staged-"));
  for (const name of names) {
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `:${name}`], { cwd: core, encoding: "buffer" });
    } catch (err) {
      process.stderr.write(`deny-list: could not read staged path ${name}: ${err.message}\n`);
      rmSync(work, { recursive: true, force: true });
      process.exit(1);
    }
    const out = path.join(work, name);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, bytes);
  }
  hits = scanForDenied(work, list);
  rmSync(work, { recursive: true, force: true });
} else {
  hits = scanForDenied(core, list);
}

if (hits.length) {
  process.stderr.write(`deny-list: ${hits.length} overlay identifier(s) in ${staged ? "the staged files" : "this package"}.\n`);
  for (const h of hits) process.stderr.write(`  ${h.file}:${h.line}  "${h.term}"  ${h.text}\n`);
  process.exit(1);
}
process.stdout.write(`deny-list: clean${staged ? " (staged)" : ""}.\n`);
