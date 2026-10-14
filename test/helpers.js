import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway overlay with one agent and the register text given. */
export function overlay(registers = {}, { denylist } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "aps-overlay-"));
  for (const [agent, text] of Object.entries(registers)) {
    const dir = path.join(root, "agents", agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "PROBLEMS.md"), text);
  }
  if (denylist !== undefined) writeFileSync(path.join(root, "denylist.txt"), denylist);
  return root;
}

export const reg = (body, mission = "ten paying customers by December") =>
  `# Problems\n\nMission: ${mission}\n\n${body}`;

export const P = (id, fields) =>
  `## ${id}. ${fields.title ?? "A problem"}\n` +
  Object.entries(fields)
    .filter(([k]) => k !== "title")
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n") +
  "\n";
