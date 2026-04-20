import { collapseWhitespace, splitLines, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import type { CodeSymbolDraft, SourceDocumentContext } from "../knowledge-model.js";
import type { KbCodeSymbolKind } from "../types.js";

interface PendingSymbol {
  kind: KbCodeSymbolKind;
  name: string;
  qualifiedName: string;
  parentSymbol: string | null;
  startLine: number;
  signatureText: string;
  docComment: string | null;
  braceDepthAtStart: number;
}

function detectLanguage(path: string): string {
  const match = /\.([^.]+)$/.exec(path.toLowerCase());
  return match?.[1] ?? "unknown";
}

function extractDependencies(content: string): string[] {
  return uniqueStrings(
    [
      ...[...content.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? ""),
      ...[...content.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? ""),
      ...[...content.matchAll(/\b([A-Z][A-Za-z0-9_]+)\(/g)].map((match) => match[1] ?? "")
    ],
    16
  );
}

function extractDocComment(lines: string[], declarationLine: number): string | null {
  let cursor = declarationLine - 2;
  const collected: string[] = [];
  let insideBlock = false;
  while (cursor >= 0) {
    const line = lines[cursor].trim();
    if (!line) {
      if (collected.length) break;
      cursor -= 1;
      continue;
    }
    if (line.startsWith("*/")) {
      insideBlock = true;
      collected.unshift(line.replace(/^\*\/\s*/, ""));
      cursor -= 1;
      continue;
    }
    if (insideBlock) {
      collected.unshift(line.replace(/^\/?\*+\/?\s?/, "").replace(/^\*\s?/, ""));
      if (line.startsWith("/**") || line.startsWith("/*")) break;
      cursor -= 1;
      continue;
    }
    if (line.startsWith("//")) {
      collected.unshift(line.replace(/^\/\/\s?/, ""));
      cursor -= 1;
      continue;
    }
    break;
  }
  const comment = collapseWhitespace(collected.join(" "));
  return comment || null;
}

function countBraces(text: string): number {
  const opens = (text.match(/\{/g) ?? []).length;
  const closes = (text.match(/\}/g) ?? []).length;
  return opens - closes;
}

function symbolKindForDeclaration(raw: string): KbCodeSymbolKind | null {
  if (/^\s*export\s+default\s+class\b|^\s*class\b/.test(raw)) return "class";
  if (/^\s*export\s+default\s+function\b|^\s*(?:export\s+)?async\s+function\b|^\s*(?:export\s+)?function\b/.test(raw)) return "function";
  if (/^\s*(?:export\s+)?interface\b/.test(raw)) return "interface";
  if (/^\s*(?:export\s+)?type\b/.test(raw)) return "type";
  if (/^\s*(?:export\s+)?enum\b/.test(raw)) return "enum";
  if (/^\s*(?:export\s+)?(?:const|let|var)\b/.test(raw)) return "constant";
  if (/^\s*(?:public|private|protected)?\s*(?:static\s+)?[A-Za-z0-9_]+\s*\(/.test(raw)) return "method";
  return null;
}

function extractSymbolName(raw: string, kind: KbCodeSymbolKind): string | null {
  const patterns: Record<KbCodeSymbolKind, RegExp[]> = {
    module: [],
    class: [/class\s+([A-Za-z0-9_]+)/],
    function: [/function\s+([A-Za-z0-9_]+)/, /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/],
    method: [/([A-Za-z0-9_]+)\s*\(/],
    interface: [/interface\s+([A-Za-z0-9_]+)/],
    type: [/type\s+([A-Za-z0-9_]+)/],
    enum: [/enum\s+([A-Za-z0-9_]+)/],
    constant: [/(?:const|let|var)\s+([A-Za-z0-9_]+)/],
    exported_utility: [/([A-Za-z0-9_]+)\s*\(/]
  };
  for (const pattern of patterns[kind] ?? []) {
    const match = pattern.exec(raw);
    if (match?.[1]) return match[1];
  }
  return null;
}

function buildSymbolDraft(context: SourceDocumentContext, input: PendingSymbol, endLine: number, lines: string[], fullContent: string): CodeSymbolDraft {
  const body = lines.slice(input.startLine - 1, endLine).join("\n");
  const language = detectLanguage(context.path);
  const dependencies = extractDependencies(body);
  return {
    id: stableUuidFromParts([
      context.knowledgeSpace,
      context.repoId,
      context.branch,
      context.buildVersion,
      context.path,
      input.qualifiedName,
      String(input.startLine),
      String(endLine)
    ]),
    sourceDocId: context.docId,
    path: context.path,
    language,
    symbolKind: input.kind,
    symbolName: input.name,
    qualifiedName: input.qualifiedName,
    parentSymbol: input.parentSymbol,
    startLine: input.startLine,
    endLine,
    signatureText: summarizeText(collapseWhitespace(input.signatureText), 240),
    docComment: input.docComment,
    bodySummary: summarizeText(collapseWhitespace(body), 320),
    dependencyRefs: { dependencies },
    metadata: {
      parser: "language_fallback_signature",
      degraded_quality: true,
      language,
      lineCount: endLine - input.startLine + 1,
      fileHashHint: fullContent.length
    }
  };
}

export function parseCodeSymbols(context: SourceDocumentContext): CodeSymbolDraft[] {
  const lines = splitLines(context.content);
  const symbols: CodeSymbolDraft[] = [];
  const stack: PendingSymbol[] = [];
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const kind = symbolKindForDeclaration(rawLine);
    if (kind) {
      const name = extractSymbolName(rawLine, kind);
      if (name) {
        const parent = stack.at(-1);
        const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
        stack.push({
          kind,
          name,
          qualifiedName,
          parentSymbol: parent?.qualifiedName ?? null,
          startLine: index + 1,
          signatureText: rawLine.trim(),
          docComment: extractDocComment(lines, index + 1),
          braceDepthAtStart: braceDepth
        });
      }
    }

    braceDepth += countBraces(rawLine);

    while (stack.length) {
      const current = stack.at(-1);
      if (!current) break;
      const closesImmediately = current.kind !== "class" && current.kind !== "method" && !rawLine.includes("{");
      if (closesImmediately && index + 1 > current.startLine) {
        symbols.push(buildSymbolDraft(context, current, index + 1, lines, context.content));
        stack.pop();
        continue;
      }
      if (braceDepth <= current.braceDepthAtStart) {
        symbols.push(buildSymbolDraft(context, current, Math.max(current.startLine, index + 1), lines, context.content));
        stack.pop();
        continue;
      }
      break;
    }
  }

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    symbols.push(buildSymbolDraft(context, current, lines.length, lines, context.content));
  }

  return symbols.filter((symbol, index, all) => all.findIndex((item) => item.id === symbol.id) === index);
}
