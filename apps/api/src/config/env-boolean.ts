import { z } from "zod";

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off", ""]);

export function parseBooleanEnvValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_ENV_VALUES.has(normalized)) return true;
    if (FALSE_ENV_VALUES.has(normalized)) return false;
  }

  return value;
}

export function envBoolean(defaultValue: boolean) {
  return z.preprocess(parseBooleanEnvValue, z.boolean()).default(defaultValue);
}
