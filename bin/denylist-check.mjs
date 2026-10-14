#!/usr/bin/env node
// Run the deny-list check over the core, or over just the staged files.
//
//   APS_OVERLAY=… node bin/denylist-check.mjs            the whole core
//   APS_OVERLAY=… node bin/denylist-check.mjs --staged    what is about to commit

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { checkCore, readDenylist, scanText } from "../lib/denylist.js";

const core = path.resolve(new URL("..", import.meta.url).pathname);
const overlay = process.env.APS_OVERLAY ?? "";
const staged = process.argv.includes("--staged");

let files;
if (staged) {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: core, encoding: "utf8" });
  files = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!files.length) {
    process.stdout.write("deny-list: nothing staged.\n");
    process.exit(0);
  }
  if (!overlay) {
    process.stderr.write("deny-list: APS_OVERLAY is required for a staged check.\n");
    process.exit(1);
  }
  const terms = await readDenylist(path.join(overlay, "denylist.txt"));
  const hits = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `:${file}`], { cwd: core, encoding: "buffer" });
    } catch {
      continue;
    }
    if (bytes.subarray(0, 8192).includes(0)) continue;
    hits.push(...scanText(file, bytes.toString("utf8"), terms));
  }
  if (hits.length) {
    process.stderr.write(`deny-list: ${hits.length} overlay identifier(s) in the staged core.\n`);
    for (const h of hits) process.stderr.write(`  ${h.file}:${h.line}  ${h.term}  ${h.text}\n`);
    process.exit(1);
  }
  process.stdout.write(`deny-list: clean (${files.length} staged file(s)).\n`);
  process.exit(0);
}

const r = await checkCore(core, overlay, { files });
if (r.status === "passed") {
  process.stdout.write(`deny-list: clean${staged ? ` (${files.length} staged file(s))` : ""}.\n`);
  process.exit(0);
}
if (r.status === "skipped") {
  process.stdout.write(`deny-list: skipped — ${r.reason}.\n`);
  process.exit(0);
}
process.stderr.write(`deny-list: ${r.reason}.\n`);
for (const h of r.hits ?? []) process.stderr.write(`  ${h.file}:${h.line}  ${h.term}  ${h.text}\n`);
process.exit(1);
