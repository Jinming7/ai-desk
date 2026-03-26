import crypto from "node:crypto";
import type { ChunkDraft, ParsedSection } from "./types.js";

export interface ChunkingOptions {
  targetTokens: number;
  overlapTokens: number;
}

function hash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.ceil(text.trim().split(/\s+/).length * 1.2);
}

function splitLongBlock(block: string): string[] {
  return block
    .split(/(?<=[\.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitIntoUnits(text: string): string[] {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const blocks = normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  const units: string[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const listLikeLines = lines.filter((line) => /^([-*+]\s+|\d+\.\s+)/.test(line));
    if (listLikeLines.length > 0) {
      for (const line of listLikeLines) {
        units.push(line.replace(/^([-*+]\s+|\d+\.\s+)/, "").trim());
      }
      const nonList = lines.filter((line) => !/^([-*+]\s+|\d+\.\s+)/.test(line)).join(" ").trim();
      if (nonList) {
        if (estimateTokens(nonList) <= 120) units.push(nonList);
        else units.push(...splitLongBlock(nonList));
      }
      continue;
    }

    const merged = lines.join(" ").trim();
    if (!merged) continue;
    if (estimateTokens(merged) <= 120) {
      units.push(merged);
      continue;
    }
    units.push(...splitLongBlock(merged));
  }

  return units.filter(Boolean);
}

export function buildChunks(docKey: string, sections: ParsedSection[], options: ChunkingOptions): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let ordinal = 0;

  for (const section of sections) {
    const units = splitIntoUnits(section.content);
    if (!units.length) {
      continue;
    }

    let cursor = 0;
    while (cursor < units.length) {
      const startCursor = cursor;
      let acc: string[] = [];
      let tokenCount = 0;

      while (cursor < units.length) {
        const unit = units[cursor];
        const unitTokens = estimateTokens(unit);
        if (acc.length > 0 && tokenCount + unitTokens > options.targetTokens) {
          break;
        }
        acc.push(unit);
        tokenCount += unitTokens;
        cursor += 1;
      }

      const content = acc.join(" ").trim();
      if (!content) {
        cursor = startCursor + 1;
        continue;
      }

      const contentHash = hash(content);
      const stableInput = `${docKey}|${section.headingPath}|${ordinal}|${contentHash}`;
      const id = hash(stableInput);

      chunks.push({
        id,
        headingPath: section.headingPath,
        ordinal,
        content,
        contentHash,
        tokenCount,
        metadata: {
          sectionOrder: section.order,
          sectionTitle: section.title
        }
      });

      ordinal += 1;

      if (options.overlapTokens > 0 && cursor < units.length) {
        let rewindTokens = 0;
        let rewindCount = 0;
        for (let i = acc.length - 1; i >= 0; i -= 1) {
          rewindTokens += estimateTokens(acc[i]);
          rewindCount += 1;
          if (rewindTokens >= options.overlapTokens) break;
        }
        cursor = Math.max(startCursor + 1, cursor - rewindCount);
      }
    }
  }

  return chunks;
}
