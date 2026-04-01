import { collapseWhitespace, splitLines, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import type { SourceDocumentContext, TestBehaviorDraft } from "../knowledge-model.js";

function extractSignalValues(text: string): string[] {
  return uniqueStrings(
    [
      ...[...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi)].map((match) => String(match[1] ?? "").toUpperCase()),
      ...[...text.matchAll(/\/[A-Za-z0-9_./{}:-]+/g)].map((match) => match[0] ?? ""),
      ...[...text.matchAll(/\b(?:read|write):[A-Za-z0-9:_-]+\b/g)].map((match) => match[0] ?? ""),
      ...[...text.matchAll(/\b(page not found|unauthorized|forbidden|redirect uri|callback)\b/gi)].map((match) => match[1] ?? "")
    ],
    12
  );
}

export function parseTestBehaviors(context: SourceDocumentContext): TestBehaviorDraft[] {
  const lines = splitLines(context.content);
  const behaviors: TestBehaviorDraft[] = [];
  let currentTitle = "";
  let currentStart = 1;
  let block: string[] = [];

  const flush = () => {
    const summary = summarizeText(collapseWhitespace(block.join(" ")), 320);
    if (!currentTitle || !summary) {
      block = [];
      return;
    }
    const behaviorKey = collapseWhitespace(currentTitle).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-");
    behaviors.push({
      id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, behaviorKey]),
      sourceDocId: context.docId,
      path: context.path,
      behaviorKey,
      title: currentTitle,
      summary,
      assertions: {
        lines: block.filter((line) => /\b(expect|assert|should|must|equal|match|deepEqual)\b/i.test(line)).slice(0, 8)
      },
      signals: {
        signals: extractSignalValues(summary)
      },
      sourceLocation: { lineStart: currentStart, lineEnd: currentStart + block.length - 1 },
      metadata: { parser: "test_behavior_fallback", degraded_quality: true }
    });
    block = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /\b(?:test|it)\(\s*["'`](.+?)["'`]/.exec(line);
    if (match?.[1]) {
      flush();
      currentTitle = collapseWhitespace(match[1]);
      currentStart = index + 1;
      block = [line];
      continue;
    }
    if (currentTitle) block.push(line);
  }

  flush();
  return behaviors;
}
