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

function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[\.!?。！？])\s+|\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildChunks(docKey: string, sections: ParsedSection[], options: ChunkingOptions): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let ordinal = 0;

  for (const section of sections) {
    const sentences = splitIntoSentences(section.content);
    if (!sentences.length) {
      continue;
    }

    let cursor = 0;
    while (cursor < sentences.length) {
      const startCursor = cursor;
      let acc: string[] = [];
      let tokenCount = 0;

      while (cursor < sentences.length) {
        const sentence = sentences[cursor];
        const sentenceTokens = estimateTokens(sentence);
        if (acc.length > 0 && tokenCount + sentenceTokens > options.targetTokens) {
          break;
        }
        acc.push(sentence);
        tokenCount += sentenceTokens;
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

      if (options.overlapTokens > 0 && cursor < sentences.length) {
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
