import type { MemorySignalDraft } from "../memory-types.js";
import { uniqueStrings } from "../knowledge-common.js";

export function generateSignals(signals: Array<{ type: string; value: string; weight?: number }>): MemorySignalDraft[] {
  return uniqueStrings(signals.map((item) => `${item.type}::${item.value}`), 24).map((encoded) => {
    const [type, value] = encoded.split("::");
    const original = signals.find((item) => item.type === type && item.value === value);
    return {
      signal_type: type,
      signal_value: value,
      weight: original?.weight ?? 0.8
    };
  });
}
