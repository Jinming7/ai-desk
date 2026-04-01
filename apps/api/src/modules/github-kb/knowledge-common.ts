import crypto from "node:crypto";

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function normalizeLookup(input: string): string {
  return collapseWhitespace(input).toLowerCase();
}

export function uniqueStrings(input: Array<string | undefined | null>, limit = 24): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = collapseWhitespace(String(item ?? ""));
    if (!value) continue;
    const key = normalizeLookup(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

export function stableUuidFromParts(parts: string[]): string {
  const hex = crypto.createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

export function summarizeText(input: string, limit = 240): string {
  const normalized = collapseWhitespace(input);
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, Math.max(32, limit - 1)).trimEnd() + "…";
}

export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

export function splitLines(input: string): string[] {
  return input.replace(/\r\n/g, "\n").split("\n");
}
