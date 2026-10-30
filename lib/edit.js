// Edit one entry's fields in the register text, leaving every other byte alone.
// Hand-written registers stay readable, so these edits are line-level, not a
// re-render of a parsed model. The section and field scanner comes from
// lib/register.js, so the editor and the parser always mean the same entry and
// the same line. Both read the comment-free view of each line, so the
// template's commented example is never the entry an edit lands on.

import { FIELD, HEADING, ID_HEADING, fieldKey, splitLines, uncomment } from "./register.js";

/**
 * The first heading for this id, ending at the next heading of any kind.
 * @param {string[]} visible lines with their comment spans blanked out
 */
function sectionRange(visible, id) {
  const want = String(id).toUpperCase();
  let start = -1;
  for (let i = 0; i < visible.length; i += 1) {
    if (!HEADING.test(visible[i])) continue;
    const head = visible[i].match(ID_HEADING);
    if (start < 0) {
      if (head && head[1].toUpperCase() === want) start = i;
      continue;
    }
    return [start, i];
  }
  return start < 0 ? null : [start, visible.length];
}

const keyOf = (row) => {
  const raw = row.visible.match(FIELD)?.[1];
  return raw === undefined ? undefined : fieldKey(raw);
};

/**
 * @param {string} text   the whole register
 * @param {string} id     entry id, e.g. "P2"
 * @param {object} fields field name -> value; null or "" removes the line
 * @returns {string} the new register text
 */
export function setFields(text, id, fields) {
  const { lines, eol } = splitLines(text);
  const { lines: visible } = uncomment(lines);
  const range = sectionRange(visible, id);
  if (!range) throw new Error(`${id} is not in the register`);
  const [start, end] = range;
  // Each row carries the real line to write back and the comment-free line to
  // read, so a splice can never slide the two out of step.
  const body = lines.slice(start + 1, end).map((raw, i) => ({ text: raw, visible: visible[start + 1 + i] }));
  let lastField = -1;
  for (let i = 0; i < body.length; i += 1) if (FIELD.test(body[i].visible)) lastField = i;

  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = fieldKey(rawKey);
    const value = rawValue === null || rawValue === undefined ? null : String(rawValue).replace(/\s+/g, " ").trim();
    // The parser keeps the last line for a repeated field, so edit that one and
    // drop the earlier copies rather than writing a value nothing will read.
    const all = body.map((row, i) => (keyOf(row) === key ? i : -1)).filter((i) => i >= 0);
    for (const i of all.slice(0, -1).reverse()) {
      body.splice(i, 1);
      if (i <= lastField) lastField -= 1;
    }
    const target = all.length ? body.findIndex((row) => keyOf(row) === key) : -1;
    if (value === null || value === "") {
      if (target >= 0) {
        body.splice(target, 1);
        if (target <= lastField) lastField -= 1;
      }
      continue;
    }
    const line = `- ${key}: ${value}`;
    if (target >= 0) {
      body[target] = { text: line, visible: line };
    } else {
      body.splice(lastField + 1, 0, { text: line, visible: line });
      lastField += 1;
    }
  }
  return [...lines.slice(0, start + 1), ...body.map((row) => row.text), ...lines.slice(end)].join(eol);
}

export function hasEntry(text, id) {
  const { lines } = splitLines(text);
  return sectionRange(uncomment(lines).lines, id) !== null;
}
