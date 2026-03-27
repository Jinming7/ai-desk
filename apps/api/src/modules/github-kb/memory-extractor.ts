import crypto from "node:crypto";
import type { MemoryEntryDraft, MemorySignalDraft, SupportExactSignals } from "./memory-types.js";

type ChunkLike = {
  id: string;
  headingPath: string;
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
};

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeLookup(input: string): string {
  return collapseWhitespace(input).toLowerCase();
}

function uniqueStrings(input: Array<string | undefined | null>, limit = 12): string[] {
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

function stableUuidFromParts(parts: string[]): string {
  const hex = crypto.createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function sentenceCandidates(content: string): string[] {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？.!?])\s+/))
    .map((line) => collapseWhitespace(line.replace(/^[-*]\s+/, "").replace(/^[0-9]+\.\s+/, "")))
    .filter((line) => line.length >= 18);
}

function getSupportMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return ((metadata.supportEvidence ?? {}) as Record<string, unknown>) || {};
}

function getMetadataList(metadata: Record<string, unknown>, key: string): string[] {
  const raw = metadata[key];
  return Array.isArray(raw) ? uniqueStrings(raw.map((item) => String(item ?? "")), 10) : [];
}

function getLastHeading(headingPath: string, fallback: string): string {
  const parts = headingPath
    .split(">")
    .map((item) => collapseWhitespace(item))
    .filter(Boolean);
  return parts.at(-1) || fallback;
}

function inferMemoryKind(supportMetadata: Record<string, unknown>): MemoryEntryDraft["memory_kind"] {
  const evidenceKind = normalizeLookup(String(supportMetadata.evidence_kind ?? ""));
  if (evidenceKind === "api_operation") return "api_operation";
  if (evidenceKind === "troubleshooting") return "troubleshooting_pattern";
  if (evidenceKind === "constraint") return "constraint";
  if (evidenceKind === "procedure") return "procedure";
  if (evidenceKind === "behavior") return "behavior_rule";
  if (evidenceKind === "permission" || evidenceKind === "permission_rule") return "permission_rule";
  return "concept";
}

function inferDocKind(path: string, supportMetadata: Record<string, unknown>): string {
  const evidenceKind = normalizeLookup(String(supportMetadata.evidence_kind ?? ""));
  if (evidenceKind === "api_operation") return "openapi/api";
  if (evidenceKind === "troubleshooting") return "troubleshooting";
  if (evidenceKind === "constraint") return "rules";
  if (evidenceKind === "procedure") return path.includes("/openapi/") ? "product_guide" : "product_guide";
  if (normalizeLookup(String(supportMetadata.product_area ?? "")) === "deployment") return "deployment_runbook";
  return "general";
}

function buildCanonicalClaim(chunk: ChunkLike, supportMetadata: Record<string, unknown>, docTitle: string): string {
  const candidates = sentenceCandidates(chunk.content);
  const heading = getLastHeading(chunk.headingPath, docTitle);
  const strongSignal = candidates.find((line) =>
    /\b(callback|redirect uri|baseurl|scope|permission|order by|group by|get|post|put|patch|delete|404|401|403|500)\b|回调|重定向|授权|权限|报错|排查|步骤|支持/.test(
      line.toLowerCase()
    )
  );
  const withHeading = candidates.find((line) => normalizeLookup(line).includes(normalizeLookup(heading)));
  const chosen = strongSignal || withHeading || candidates[0] || heading;
  return collapseWhitespace(chosen);
}

function buildSummary(chunk: ChunkLike, canonicalClaim: string, supportMetadata: Record<string, unknown>): string {
  const candidates = sentenceCandidates(chunk.content)
    .filter((line) => normalizeLookup(line) !== normalizeLookup(canonicalClaim))
    .slice(0, 2);
  const actionBits = getMetadataList(supportMetadata, "actions");
  const prereqBits = getMetadataList(supportMetadata, "prerequisites");
  const extra = uniqueStrings([...candidates, ...prereqBits.slice(0, 1), ...actionBits.slice(0, 1)], 3);
  const summary = collapseWhitespace([canonicalClaim, ...extra].join(" "));
  return summary.length >= 24 ? summary : `${canonicalClaim} ${chunk.content.slice(0, 180)}`.trim();
}

function buildAliases(input: {
  title: string;
  canonicalClaim: string;
  summary: string;
  supportMetadata: Record<string, unknown>;
}): MemoryEntryDraft["aliases"] {
  const aliases: Array<{ alias: string; alias_type: string; weight: number }> = [];
  const pushAlias = (alias: string, aliasType: string, weight: number) => {
    const value = collapseWhitespace(alias);
    if (!value || value.length < 2) return;
    aliases.push({ alias: value, alias_type: aliasType, weight });
  };

  pushAlias(input.title, /[\u3400-\u9FBF]/.test(input.title) ? "ui_label" : "en_phrase", 0.88);
  for (const phrase of uniqueStrings([
    ...input.canonicalClaim.match(/page not found/gi)?.map((item) => item) ?? [],
    ...input.canonicalClaim.match(/redirect uri/gi)?.map((item) => item) ?? [],
    ...input.canonicalClaim.match(/baseurl/gi)?.map((item) => item) ?? [],
    ...input.summary.match(/callback/gi)?.map((item) => item) ?? [],
    ...input.summary.match(/oauth/gi)?.map((item) => item) ?? [],
    ...input.summary.match(/onesql/gi)?.map((item) => item) ?? [],
    ...input.summary.match(/order by/gi)?.map((item) => item) ?? [],
    ...input.summary.match(/group by/gi)?.map((item) => item) ?? []
  ], 8)) {
    pushAlias(phrase, "symptom", 0.9);
  }

  for (const item of getMetadataList(input.supportMetadata, "objects")) {
    pushAlias(item, item.includes("/") ? "path_hint" : "operation_variant", 0.8);
  }
  for (const item of getMetadataList(input.supportMetadata, "actions")) {
    pushAlias(item, "operation_variant", 0.76);
  }

  if (/回调|page not found|redirect uri|baseurl/i.test(input.summary)) {
    pushAlias("github callback 404", "en_phrase", 0.96);
    pushAlias("授权回调找不到页面", "zh_phrase", 0.98);
  }
  if (/onesql/i.test(input.summary)) {
    pushAlias("ONESQL ORDER BY", "en_phrase", 0.95);
    pushAlias("ONESQL GROUP BY", "en_phrase", 0.95);
  }

  const deduped = new Map<string, { alias: string; alias_type: string; weight: number }>();
  for (const alias of aliases) {
    const key = `${normalizeLookup(alias.alias)}::${normalizeLookup(alias.alias_type)}`;
    const previous = deduped.get(key);
    if (!previous || alias.weight > previous.weight) deduped.set(key, alias);
  }
  return [...deduped.values()].slice(0, 12).map((item) => ({
    alias: item.alias,
    alias_type: item.alias_type,
    weight: item.weight
  }));
}

function buildSignals(input: {
  canonicalClaim: string;
  summary: string;
  supportMetadata: Record<string, unknown>;
}): MemorySignalDraft[] {
  const signals: MemorySignalDraft[] = [];
  const push = (signalType: string, signalValue: string, weight: number) => {
    const value = collapseWhitespace(signalValue);
    if (!value || value.length < 2) return;
    signals.push({ signal_type: signalType, signal_value: value, weight });
  };

  for (const scope of getMetadataList(input.supportMetadata, "permissions")) push("scope", scope, 0.98);
  for (const action of getMetadataList(input.supportMetadata, "actions")) {
    if (/^(get|post|put|patch|delete|head|options)$/i.test(action)) push("http_method", action.toUpperCase(), 0.92);
    push("action", action, 0.76);
  }
  for (const object of getMetadataList(input.supportMetadata, "objects")) {
    push(object.includes("/") ? "api_path" : "object", object, object.includes("/") ? 0.96 : 0.72);
  }

  const sourceText = `${input.canonicalClaim} ${input.summary}`;
  for (const token of uniqueStrings(sourceText.match(/\b[A-Z]{3,}[A-Z0-9_:-]*\b/g) ?? [], 6)) push("error_code", token, 0.82);
  if (/callback/i.test(sourceText)) push("callback", "callback", 0.92);
  if (/redirect uri/i.test(sourceText)) push("redirect_uri", "redirect uri", 0.99);
  if (/baseurl/i.test(sourceText)) push("baseurl", "baseurl", 0.95);
  if (/page not found/i.test(sourceText)) push("page_text", "page not found", 0.94);
  if (/oauth/i.test(sourceText)) push("object", "oauth", 0.86);

  const deduped = new Map<string, MemorySignalDraft>();
  for (const signal of signals) {
    const key = `${normalizeLookup(signal.signal_type)}::${normalizeLookup(signal.signal_value)}`;
    const previous = deduped.get(key);
    if (!previous || signal.weight > previous.weight) deduped.set(key, signal);
  }
  return [...deduped.values()].slice(0, 14);
}

function isValidEntry(input: {
  canonicalClaim: string;
  summary: string;
  sources: string[];
  productArea: string;
  docKind: string;
}): boolean {
  return (
    input.canonicalClaim.length >= 24 &&
    input.summary.length >= 24 &&
    input.sources.length >= 1 &&
    Boolean(collapseWhitespace(input.productArea)) &&
    Boolean(collapseWhitespace(input.docKind))
  );
}

export function extractSupportSignals(query: string): SupportExactSignals {
  const compact = collapseWhitespace(query);
  const methods = uniqueStrings(compact.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi)?.map((item) => item.toUpperCase()) ?? [], 6);
  const apiPaths = uniqueStrings(compact.match(/\/[A-Za-z0-9_./{}:-]+/g) ?? [], 6);
  const scopes = uniqueStrings(
    [
      ...compact.match(/\b(?:read|write):[A-Za-z0-9:_-]+\b/g)?.map((item) => item) ?? [],
      ...[...compact.matchAll(/\bscope(?:s)?\s*[:=]?\s*([A-Za-z0-9:_-]+)/gi)].map((item) => item[1] ?? "")
    ],
    8
  );
  const callbacks = /callback|回调/i.test(compact) ? ["callback"] : [];
  const redirectUris = /redirect uri|redirect url|重定向/i.test(compact) ? ["redirect uri"] : [];
  const baseUrls = /baseurl|base url/i.test(compact) ? ["baseurl"] : [];
  const errorCodes = uniqueStrings(
    [
      ...compact.match(/\b[45][0-9]{2}\b/g)?.map((item) => item) ?? [],
      ...[...compact.matchAll(/"errorCode"\s*:\s*"([^"]+)"/gi)].map((item) => item[1] ?? "")
    ],
    8
  );
  const errorTexts = uniqueStrings(
    [
      ...[/page not found/i.test(compact) ? "page not found" : "", /unauthorized/i.test(compact) ? "unauthorized" : "", /forbidden/i.test(compact) ? "forbidden" : ""]
    ],
    6
  );
  const pageTexts = uniqueStrings([/page not found/i.test(compact) ? "page not found" : ""], 4);
  const objects = uniqueStrings(compact.match(/\b(issue comment|comment|oauth|token|onesql|webhook|github|redirect uri|callback)\b/gi)?.map((item) => item.toLowerCase()) ?? [], 8);
  const actions = uniqueStrings(compact.match(/\b(create|update|delete|get|list|search|query|configure|deploy|reset|rotate|authorize)\b/gi)?.map((item) => item.toLowerCase()) ?? [], 8);
  const all = uniqueStrings([...methods, ...apiPaths, ...scopes, ...callbacks, ...redirectUris, ...baseUrls, ...errorCodes, ...errorTexts, ...pageTexts, ...objects, ...actions], 24);

  return {
    methods,
    apiPaths,
    scopes,
    callbacks,
    redirectUris,
    baseUrls,
    errorCodes,
    errorTexts,
    pageTexts,
    objects,
    actions,
    all
  };
}

export function extractMemoryEntriesForDocument(input: {
  repoId: string;
  branch: string;
  docId: string;
  path: string;
  title: string;
  buildVersion: string;
  docSupportEvidence: Record<string, unknown>;
  chunks: ChunkLike[];
}): MemoryEntryDraft[] {
  const entries: MemoryEntryDraft[] = [];

  for (const chunk of input.chunks) {
    const supportMetadata = {
      ...input.docSupportEvidence,
      ...getSupportMetadata(chunk.metadata)
    };
    const memoryKind = inferMemoryKind(supportMetadata);
    const title = getLastHeading(chunk.headingPath, input.title);
    const canonicalClaim = buildCanonicalClaim(chunk, supportMetadata, input.title);
    const summary = buildSummary(chunk, canonicalClaim, supportMetadata);
    const productArea = collapseWhitespace(String(supportMetadata.product_area ?? "general")) || "general";
    const docKind = inferDocKind(input.path, supportMetadata);
    const actions = getMetadataList(supportMetadata, "actions");
    const objects = getMetadataList(supportMetadata, "objects");
    const actionType = collapseWhitespace(String(actions[0] ?? supportMetadata.action_type ?? "")) || null;
    const deploymentModel = collapseWhitespace(String(supportMetadata.deployment_model ?? "")) || null;
    const objectType =
      collapseWhitespace(String(objects[0] ?? supportMetadata.object_type ?? "")) ||
      collapseWhitespace(String(supportMetadata.api_path ?? "")) ||
      null;
    const aliases = buildAliases({ title, canonicalClaim, summary, supportMetadata });
    const signals = buildSignals({ canonicalClaim, summary, supportMetadata });
    const sources = [chunk.id];

    if (!isValidEntry({ canonicalClaim, summary, sources, productArea, docKind })) continue;

    const searchText = collapseWhitespace(
      [
        title,
        canonicalClaim,
        summary,
        ...aliases.map((item) => item.alias),
        ...signals.map((item) => item.signal_value),
        productArea,
        docKind,
        actionType,
        deploymentModel,
        objectType
      ]
        .filter(Boolean)
        .join(" ")
    );

    entries.push({
      id: stableUuidFromParts([input.repoId, input.branch, input.docId, chunk.id, memoryKind, canonicalClaim]),
      repo_id: input.repoId,
      branch: input.branch,
      doc_id: input.docId,
      path: input.path,
      memory_kind: memoryKind,
      title,
      canonical_claim: canonicalClaim,
      summary,
      product_area: productArea,
      doc_kind: docKind,
      action_type: actionType,
      deployment_model: deploymentModel,
      object_type: objectType,
      is_static: memoryKind === "concept" || memoryKind === "permission_rule" || memoryKind === "constraint",
      build_version: input.buildVersion,
      metadata_json: {
        heading_path: chunk.headingPath,
        ordinal: chunk.ordinal,
        extracted_from: "chunk",
        source_chunk_count: 1
      },
      search_text: searchText,
      aliases,
      signals,
      sources: [
        {
          doc_id: input.docId,
          chunk_id: chunk.id,
          heading_path: chunk.headingPath,
          source_score: 1,
          source_metadata_json: { ordinal: chunk.ordinal }
        }
      ]
    });
  }

  return entries;
}
