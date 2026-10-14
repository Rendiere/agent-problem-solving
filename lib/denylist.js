// The core must not carry one operator's identifiers (R31). The overlay supplies
// a deny-list, one identifier per line, and this scan fails on any match inside
// the core. The public repository has no list, so protection lives on the
// operator's side: a pre-commit hook runs this with APS_OVERLAY set, and the
// publish step runs it before copying anything out.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);

/**
 * Read the overlay's list. A plain line is an identifier that must not appear.
 * An `allow:` line is a phrase that may, which is how the repository's own
 * public address survives a list that denies its owner's name everywhere else.
 *
 * @returns {{terms: string[], allowed: string[]}}
 */
export function readDenylist(file) {
  const terms = [];
  const allowed = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^allow:\s*(.+)$/i);
    if (m) allowed.push(m[1].trim());
    else terms.push(line);
  }
  return { terms, allowed };
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) yield* walk(full);
    // Every regular file is scanned, whatever it is called. A decision log or a
    // fixture with no familiar extension is the likeliest way a name leaks.
    else if (info.isFile()) yield full;
  }
}

// A file counts as binary when the first 8 KB hold a NUL byte.
function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

// A term counts as present when it stands as its own word. A hyphen is a word
// break, not part of the word, so a listed name still trips inside a compound
// like "<name>-agent" or "<name>-2", while an ordinary longer word that happens
// to contain the same letters does not.
const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const boundary = (term, flags = "i") => new RegExp(`(?<!\\w)${quote(term)}(?!\\w)`, flags);

// An allowed phrase has to be the whole thing. A hyphen counts as part of the
// word here, the opposite of the rule for a listed name, so allowing
// "owner/project" does not also allow "owner/project-private".
const wholePhrase = (phrase) => new RegExp(`(?<![\\w-])${quote(phrase)}(?![\\w-])`, "gi");

/**
 * Blank out every allowed phrase before looking for a listed name. A name that
 * also stands on its own somewhere in the line still trips, so allowing the
 * repository's address does not quietly allow its owner's name.
 *
 * Two things the simple version got wrong. An allowed phrase has to match on the
 * same word boundary the terms do, or "owner/project" also allows
 * "owner/project-private". And the match indices have to come from the original
 * string: a character that changes length when lowercased shifts an offset taken
 * from a lowercased copy, which blanks the text after the phrase instead.
 */
function withoutAllowed(text, allowed) {
  let out = text;
  for (const re of allowed) {
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  return out;
}

/**
 * @param {string[]|{terms: string[], allowed?: string[]}} list
 * @returns {Array<{file: string, line: number, term: string, text: string}>}
 */
export function scanForDenied(coreDir, list, allowedArg = []) {
  const terms = Array.isArray(list) ? list : (list?.terms ?? []);
  const allowedPhrases = Array.isArray(list) ? allowedArg : (list?.allowed ?? allowedArg);
  const allowed = allowedPhrases.filter(Boolean).map(wholePhrase);
  const patterns = terms.map((term) => [term, boundary(term)]);
  const hits = [];
  for (const file of walk(coreDir)) {
    const buffer = readFileSync(file);
    if (isBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    lines.forEach((raw, i) => {
      const text = allowed.length ? withoutAllowed(raw, allowed) : raw;
      for (const [term, re] of patterns) {
        if (re.test(text)) hits.push({ file: path.relative(coreDir, file), line: i + 1, term, text: raw.trim().slice(0, 120) });
      }
    });
  }
  return hits;
}
