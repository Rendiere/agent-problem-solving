// Check plugin config against the manifest's schema. The gateway does this on
// load; this is the same check in a form the tests can call, so a config key
// that was removed (such as the old ceilingTokens) fails here too.

import { readFileSync } from "node:fs";

export function manifestSchema(file = new URL("../openclaw.plugin.json", import.meta.url)) {
  return JSON.parse(readFileSync(file, "utf8")).configSchema;
}

export function validateConfig(cfg, schema = manifestSchema()) {
  const errors = [];
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return ["config must be an object"];
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) if (cfg[key] === undefined) errors.push(`${key} is required`);
  for (const [key, value] of Object.entries(cfg)) {
    const spec = props[key];
    if (!spec) {
      if (schema.additionalProperties === false) errors.push(`${key} is not a config key for this plugin`);
      continue;
    }
    const type = spec.type;
    if (type === "boolean" && typeof value !== "boolean") errors.push(`${key} must be true or false`);
    if (type === "string" && typeof value !== "string") errors.push(`${key} must be a string`);
    if (type === "string" && typeof value === "string" && spec.minLength && value.length < spec.minLength) errors.push(`${key} must not be empty`);
    if (type === "string" && typeof value === "string" && spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push(`${key} must match ${spec.pattern}`);
    if (type === "integer" && !Number.isInteger(value)) errors.push(`${key} must be a whole number`);
    if (type === "integer" && Number.isInteger(value) && spec.minimum !== undefined && value < spec.minimum) errors.push(`${key} must be at least ${spec.minimum}`);
    if (type === "array" && !Array.isArray(value)) errors.push(`${key} must be a list`);
  }
  if (Number.isInteger(cfg.warnTokens) && Number.isInteger(cfg.highTokens) && cfg.highTokens <= cfg.warnTokens) {
    errors.push("highTokens must be above warnTokens");
  }
  return errors;
}
