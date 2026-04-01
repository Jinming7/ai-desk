import type { MemoryAliasDraft } from "../memory-types.js";
import { uniqueStrings } from "../knowledge-common.js";

export function generateAliases(aliases: string[]): MemoryAliasDraft[] {
  return uniqueStrings(aliases, 16).map((alias, index) => ({
    alias,
    alias_type: /[\u3400-\u9fbf]/.test(alias) ? "zh_phrase" : alias.includes("/") ? "path_hint" : "canonical",
    weight: Math.max(0.55, 0.95 - index * 0.04)
  }));
}
