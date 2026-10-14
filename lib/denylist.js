// Does anything in the core name a person, a chat or a business?
//
// The operator keeps a list of their own identifiers in the overlay. The core
// never holds that list: the check runs in the operator's working copy, where
// the overlay is, and in the copy made when the core is published (R31, KTD2).
// In the public repository there is no list, so the check passes and says so.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Directories that hold no publishable source. */
const SKIP_DIRS = new Set([".git", "node_modules", ".state", "coverage", "__pycache__"]);

export async function readDenylist(file) {
  const text = await readFile(file, "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

export async function listTextFiles(root, rel = "") {
  const out = [];
  const dir = path.join(root, rel);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const next = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listTextFiles(root, next)));
    else out.push(next);
  }
  return out;
}

/**
 * @returns {Promise<Array<{file:string,line:number,term:string,text:string}>>}
 */
export async function scan(root, terms, { files } = {}) {
  const list = files ?? (await listTextFiles(root));
  const hits = [];
  for (const file of list) {
    let bytes;
    try {
      bytes = await readFile(path.join(root, file));
    } catch {
      continue;
    }
    // Scan every regular file, including extensionless files and formats the
    // core may add later. A NUL in the first 8 KiB is the binary test.
    if (bytes.subarray(0, 8192).includes(0)) continue;
    const text = bytes.toString("utf8");
    hits.push(...scanText(file, text, terms));
  }
  return hits;
}

export function scanText(file, text, terms) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (const term of terms) {
    // Hyphen and underscore are separators for a bare-name deny-list term, so
    // an identifier is still caught inside a compound filename or label.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = /^[\w-]+$/.test(term)
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu")
      : new RegExp(escaped, "i");
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) hits.push({ file, line: i + 1, term, text: lines[i].trim().slice(0, 120) });
    }
  }
  return hits;
}

/**
 * The whole check, as the test and the pre-commit hook both run it.
 * @returns {Promise<{status:"passed"|"skipped"|"failed", reason?:string, hits?:Array}>}
 */
export async function checkCore(coreRoot, overlayRoot, { files } = {}) {
  if (!overlayRoot) {
    return { status: "skipped", reason: "no overlay is set, so there is no deny-list to check against" };
  }
  const file = path.join(overlayRoot, "denylist.txt");
  if (!(await stat(file).then(() => true, () => false))) {
    return { status: "failed", reason: `an overlay is set but ${file} is missing; the core cannot be checked` };
  }
  let terms;
  try {
    terms = await readDenylist(file);
  } catch (err) {
    return { status: "failed", reason: `cannot read ${file}: ${err.message}` };
  }
  if (!terms.length) return { status: "failed", reason: `${file} is empty; add one identifier per line` };
  const hits = await scan(coreRoot, terms, { files });
  return hits.length ? { status: "failed", hits, reason: `${hits.length} overlay identifier(s) in the core` } : { status: "passed", hits: [] };
}
