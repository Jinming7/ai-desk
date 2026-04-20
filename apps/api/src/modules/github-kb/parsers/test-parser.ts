import { collapseWhitespace, splitLines, uniqueStrings } from "../knowledge-common.js";
import { stableUuidFromParts, summarizeText } from "../knowledge-common.js";
import type { OpenApiOperationDraft, SourceDocumentContext, TestBehaviorDraft } from "../knowledge-model.js";

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

function normalizeBehaviorKey(input: string): string {
  return collapseWhitespace(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeMdxLine(line: string): string {
  return collapseWhitespace(
    line
      .replace(/<[^>]+>/g, " ")
      .replace(/\{["'`](.*?)["'`]\}/g, " $1 ")
      .replace(/\{[^}]+\}/g, " ")
      .replace(/[<>]/g, " ")
  );
}

function collectOpenApiResponseContracts(content: string): Array<{ responseCode: string; lineStart: number; lineEnd: number; summary: string }> {
  const lines = splitLines(content);
  const starts: Array<{ responseCode: string; lineStart: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const matched = /label=\{"([45]\d{2})"\}/.exec(lines[index]);
    if (matched?.[1]) {
      starts.push({ responseCode: matched[1], lineStart: index + 1 });
    }
  }

  return starts.flatMap((start, index) => {
    const lineEnd = (starts[index + 1]?.lineStart ?? lines.length + 1) - 1;
    const block = lines.slice(start.lineStart - 1, lineEnd);
    const description = summarizeText(
      collapseWhitespace(
        block
          .map((line) => sanitizeMdxLine(line))
          .filter((line) => {
            if (!line) return false;
            if (line === start.responseCode) return false;
            if (/^(TabItem|MimeTabs|SchemaTabs|SchemaItem|Heading|MethodEndpoint|ResponseSamples)\b/i.test(line)) return false;
            if (/^(Schema|Example|application\/json|application\/octet-stream)$/i.test(line)) return false;
            if (/^(label|value|className|schemaType|style|open|children|collapsible|language|responseExample)\s*=/i.test(line)) return false;
            return /[A-Za-z\u4e00-\u9fa5]/.test(line);
          })
          .join(" "),
      ),
      280
    );
    if (!description) return [];
    return [{ responseCode: start.responseCode, lineStart: start.lineStart, lineEnd, summary: description }];
  });
}

export function parseOpenApiResponseContractBehaviors(
  context: SourceDocumentContext,
  openApiOperations: OpenApiOperationDraft[]
): TestBehaviorDraft[] {
  if (openApiOperations.length !== 1) return [];
  const [operation] = openApiOperations;
  const contracts = collectOpenApiResponseContracts(context.content);
  return contracts.map((contract) => {
    const method = operation.method.toUpperCase();
    const routePath = operation.routePath;
    const responseCode = contract.responseCode;
    const title = `${method} ${routePath} returns ${responseCode}`;
    const summary = summarizeText(
      collapseWhitespace(`${title}. ${contract.summary}`),
      320
    );
    const behaviorKey = normalizeBehaviorKey(`${method}-${routePath}-${responseCode}`);
    return {
      id: stableUuidFromParts([context.knowledgeSpace, context.repoId, context.branch, context.buildVersion, context.path, behaviorKey]),
      sourceDocId: context.docId,
      path: context.path,
      behaviorKey,
      title,
      summary,
      assertions: {
        contractType: "openapi_response_contract",
        responseCode,
        method,
        routePath
      },
      signals: {
        signals: uniqueStrings(
          [`http_status:${responseCode}`, method, routePath, ...extractSignalValues(summary)],
          12
        )
      },
      sourceLocation: { lineStart: contract.lineStart, lineEnd: contract.lineEnd },
      metadata: {
        parser: "openapi_response_contract_mdx",
        degraded_quality: true,
        productArea: "openapi",
        docKind: "api_contract",
        objectType: "response_contract",
        responseCode,
        method,
        routePath
      }
    };
  });
}
