// Where this package's own files are, resolved once.
//
// fileURLToPath, never URL.pathname: a URL path percent-encodes, so a package
// under "My Code" becomes "My%20Code" and every path built from it is dead.
// Three places used to compute the command path separately and drifted apart,
// so they all come from here now.

import { fileURLToPath } from "node:url";
import path from "node:path";

export const packageRoot = () => path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const apsBin = () => path.join(packageRoot(), "bin", "aps.mjs");
export const hookScript = () => path.join(packageRoot(), "hooks", "reminder.mjs");
export const templateRegister = () => path.join(packageRoot(), "templates", "PROBLEMS.md");

/**
 * The command the reminder tells the agent to run. The subcommand and its
 * arguments come first, because that is the only order the command parses.
 */
export function apsCommand({ overlay, agentId, registerFile, thread, sessionKey } = {}) {
  const tail = [
    overlay ? `--overlay ${shellArg(overlay)}` : "",
    agentId ? `--agent ${shellArg(agentId)}` : "",
    registerFile && registerFile !== "PROBLEMS.md" ? `--register ${shellArg(registerFile)}` : "",
    thread ? `--thread ${shellArg(thread)}` : "",
    sessionKey ? `--session ${shellArg(sessionKey)}` : "",
  ].filter(Boolean).join(" ");
  return `node ${shellArg(apsBin())} set <ID> field=value${tail ? ` ${tail}` : ""}`;
}

/** Quote for a POSIX shell only when it needs it, and never with double quotes. */
export function shellArg(value) {
  const s = String(value ?? "");
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
