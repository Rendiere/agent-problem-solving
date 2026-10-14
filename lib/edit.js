// Edit a register's markdown in place.
//
// The register is a file a person reads and sometimes edits, so an edit changes
// only the lines it has to: a field already there is replaced where it stands, a
// new one is appended to the end of that problem's section, and everything else
// in the file comes back byte for byte.

const HEAD = /^##\s+(P\d+)\.?\s*(.*)$/;

function sectionRange(lines, id) {
  let start = -1;
  let matches = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(HEAD);
    if (m && m[1] === id) {
      matches += 1;
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && /^#{1,2}\s/.test(lines[i])) {
      if (matches > 1) throw new Error(`${id} appears more than once in the register`);
      return [start, i];
    }
  }
  if (matches > 1) throw new Error(`${id} appears more than once in the register`);
  return start >= 0 ? [start, lines.length] : null;
}

/** The last line of the section that is still a field bullet. */
function lastFieldLine(lines, start, end) {
  let last = start;
  for (let i = start + 1; i < end; i += 1) {
    if (/^ ?[-*]\s+[a-z][a-z _-]*:/i.test(lines[i])) last = i;
  }
  return last;
}

const sameKey = (line, key) => {
  const m = line.match(/^ ?[-*]\s+([a-z][a-z _-]*?):/i);
  if (!m) return false;
  return m[1].trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ") === key;
};

/**
 * Set or clear fields on one problem. A value of `null` or `""` removes the
 * line, so clearing a pending question leaves no empty field behind.
 */
export function setFields(text, id, fields) {
  const lines = String(text ?? "").split(/\r?\n/);
  const range = sectionRange(lines, id);
  if (!range) throw new Error(`${id} is not in the register`);
  let [start, end] = range;

  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = rawKey.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();
    let found = -1;
    for (let i = start + 1; i < end; i += 1) {
      if (sameKey(lines[i], key)) {
        found = i;
      }
    }
    if (found >= 0) {
      if (value) lines[found] = `- ${key}: ${value}`;
      else {
        lines.splice(found, 1);
        end -= 1;
      }
      continue;
    }
    if (!value) continue;
    const at = lastFieldLine(lines, start, end) + 1;
    lines.splice(at, 0, `- ${key}: ${value}`);
    end += 1;
  }
  return lines.join("\n");
}

/** Rename a problem's action title. */
export function setTitle(text, id, title) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(HEAD);
    if (m && m[1] === id) {
      lines[i] = `## ${id}. ${title}`;
      return lines.join("\n");
    }
  }
  throw new Error(`${id} is not in the register`);
}

export function nextId(register) {
  const n = Math.max(
    0,
    ...(register?.problems ?? []).map((p) => Number.parseInt(p.id.slice(1), 10) || 0),
  );
  return `P${n + 1}`;
}

/** Append a new problem section. */
export function addProblem(text, id, title, fields) {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `- ${k.trim().toLowerCase().replace(/[-_]+/g, " ")}: ${String(v).trim()}`)
    .join("\n");
  const base = String(text ?? "").replace(/\s*$/, "");
  return `${base}\n\n## ${id}. ${title}\n${body}\n`;
}
