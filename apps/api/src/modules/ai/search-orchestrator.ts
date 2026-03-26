import { env } from "../../config/env.js";
import type { OpenClawAdapter, OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";
import * as githubKbService from "../github-kb/service.js";
import { searchLocalDocs } from "./local-docs.js";
import type { SearchReference, SearchResponseEnvelope, SupportCaseFrame } from "./types.js";

type SearchEvidenceCollection = SearchResponseEnvelope & {
  resolvedQueries: string[];
  fallbackUsed: boolean;
};

export class SearchOrchestrator {
  constructor(private readonly adapter: OpenClawAdapter) {}

  private getMetadataList(reference: SearchReference, key: string): string[] {
    const metadata = (reference.supportMetadata ?? {}) as Record<string, unknown>;
    const raw = metadata[key];
    return Array.isArray(raw) ? raw.map((item) => String(item ?? "").toLowerCase()).filter(Boolean) : [];
  }

  private getReferenceProfile(reference: SearchReference): {
    title: string;
    heading: string;
    snippet: string;
    evidenceKind: string;
    productArea: string;
    deploymentModel: string;
    permissions: string[];
    prerequisites: string[];
    actions: string[];
    objects: string[];
    appliesTo: string[];
  } {
    const metadata = (reference.supportMetadata ?? {}) as Record<string, unknown>;
    return {
      title: String(reference.title ?? "").toLowerCase(),
      heading: String(reference.headingPath ?? "").toLowerCase(),
      snippet: String(reference.snippet ?? "").toLowerCase(),
      evidenceKind: String(metadata.evidence_kind ?? "").toLowerCase(),
      productArea: String(metadata.product_area ?? "").toLowerCase(),
      deploymentModel: String(metadata.deployment_model ?? "").toLowerCase(),
      permissions: this.getMetadataList(reference, "permissions"),
      prerequisites: this.getMetadataList(reference, "prerequisites"),
      actions: this.getMetadataList(reference, "actions"),
      objects: this.getMetadataList(reference, "objects"),
      appliesTo: this.getMetadataList(reference, "applies_to")
    };
  }

  private getReferenceSemanticText(reference: SearchReference): string {
    const profile = this.getReferenceProfile(reference);
    return [
      profile.title,
      profile.heading,
      profile.snippet,
      ...profile.permissions,
      ...profile.prerequisites,
      ...profile.actions,
      ...profile.objects,
      ...profile.appliesTo
    ]
      .filter(Boolean)
      .join(" ");
  }

  private extractQueryTerms(query?: string): string[] {
    const raw = String(query ?? "").trim().toLowerCase();
    if (!raw) return [];
    const ascii = [...raw.matchAll(/[a-z0-9:_./-]{3,}/g)].map((match) => match[0]);
    const cjk = [...raw.matchAll(/[\u4e00-\u9fff]{2,}/g)].map((match) => match[0]);
    return [...new Set([...ascii, ...cjk])].slice(0, 16);
  }

  private canonicalDocsPath(input?: string): string {
    const value = String(input ?? "").trim();
    if (!value) return "";
    return value
      .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs-open-docs\/current\//i, "open-docs/docs/")
      .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\//i, "docs/");
  }

  private buildNoResults(query: string, fallbackUsed: boolean, resolvedQueries: string[] = []): SearchEvidenceCollection {
    return {
      query,
      answer: "",
      confidence: 0,
      references: [],
      retrievalStatus: "no_results",
      unresolvedReasonCode: "NO_MATCHING_KB",
      resolvedQueries,
      fallbackUsed
    };
  }

  private buildKbUnavailable(query: string): SearchEvidenceCollection {
    return {
      query,
      answer: "",
      confidence: 0,
      references: [],
      retrievalStatus: "kb_unavailable",
      unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE",
      resolvedQueries: [],
      fallbackUsed: false
    };
  }

  private hasUsableSourceUrl(sourceUrl: string): boolean {
    if (!sourceUrl.trim()) return false;
    try {
      const parsed = new URL(sourceUrl);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  private hasUsableEvidence(reference: SearchReference): boolean {
    return Boolean(reference.documentId && reference.title && reference.snippet && this.hasUsableSourceUrl(reference.sourceUrl));
  }

  private toReference(
    hit: {
      documentId: string;
      title: string;
      snippet: string;
      sourceUrl: string;
      repoSourceUrl?: string;
      repo?: string;
      branch?: string;
      path?: string;
      commitSha?: string;
      headingPath?: string;
      supportMetadata?: Record<string, unknown>;
      chunkMetadata?: Record<string, unknown>;
      docMetadata?: Record<string, unknown>;
      score: number;
    },
    retrievedAt: string
  ): SearchReference {
    return {
      documentId: hit.documentId,
      title: hit.title,
      snippet: hit.snippet,
      sourceUrl: hit.sourceUrl,
      repoSourceUrl: hit.repoSourceUrl,
      repo: hit.repo,
      branch: hit.branch,
      path: hit.path,
      commitSha: hit.commitSha,
      headingPath: hit.headingPath,
      supportMetadata: hit.supportMetadata,
      chunkMetadata: hit.chunkMetadata,
      docMetadata: hit.docMetadata,
      authority: hit.supportMetadata && hit.supportMetadata.authority === "assistive_internal" ? "assistive_internal" : "canonical_visible",
      sourceType:
        hit.supportMetadata && typeof hit.supportMetadata.source_type === "string"
          ? (hit.supportMetadata.source_type as SearchReference["sourceType"])
          : undefined,
      score: hit.score,
      retrievedAt
    };
  }

  private isDocsComVisibleReference(reference: SearchReference): boolean {
    const repo = String(reference.repo ?? "").toLowerCase();
    const sourceUrl = String(reference.sourceUrl ?? "").toLowerCase();
    const path = this.canonicalDocsPath(reference.path).toLowerCase();
    return (
      reference.authority === "canonical_visible" &&
      (repo === "bangwork/docs-com" ||
        sourceUrl.startsWith("https://docs.ones.com/") ||
        path.startsWith("docs/") ||
        path.startsWith("open-docs/") ||
        path.startsWith("deploy-docs/"))
    );
  }

  private scoreReferenceQueryMatch(reference: SearchReference, queryTerms: string[]): number {
    if (!queryTerms.length) return 0;
    const profile = this.getReferenceProfile(reference);
    let score = 0;
    for (const term of queryTerms) {
      if (profile.title.includes(term)) score += 12;
      else if (profile.heading.includes(term)) score += 8;
      else if (profile.snippet.includes(term)) score += 3;
    }
    return score;
  }

  private mergeReferences(references: SearchReference[], options?: { query?: string }): SearchReference[] {
    const queryTerms = this.extractQueryTerms(options?.query);
    const byKey = new Map<string, SearchReference>();
    for (const item of references) {
      if (!this.hasUsableEvidence(item)) continue;
      const key = [
        this.canonicalDocsPath(item.path) || item.path || item.sourceUrl || item.documentId,
        item.headingPath || "ROOT"
      ]
        .filter(Boolean)
        .join("::");
      const previous = byKey.get(key);
      const itemQueryScore = this.scoreReferenceQueryMatch(item, queryTerms);
      const previousQueryScore = previous ? this.scoreReferenceQueryMatch(previous, queryTerms) : -1;
      if (
        !previous ||
        itemQueryScore > previousQueryScore ||
        (itemQueryScore === previousQueryScore && item.score > previous.score) ||
        (itemQueryScore === previousQueryScore && item.score === previous.score && item.snippet.length > previous.snippet.length)
      ) {
        byKey.set(key, item);
      }
    }
    const combinedScore = (reference: SearchReference) =>
      this.scoreReferenceQueryMatch(reference, queryTerms) + Math.round(reference.score * 10);
    const sorted = [...byKey.values()].sort((a, b) => combinedScore(b) - combinedScore(a) || b.score - a.score);
    const topCombinedScore = sorted[0] ? combinedScore(sorted[0]) : 0;
    const scoreFloor = topCombinedScore > 0 ? Math.max(6, Math.round(topCombinedScore * 0.55)) : 0;
    const perDocument = new Map<string, number>();
    const limited: SearchReference[] = [];
    for (const item of sorted) {
      if (limited.length >= 4 && combinedScore(item) < scoreFloor) continue;
      const docKey = item.path || item.documentId || item.sourceUrl || item.title;
      const seen = perDocument.get(docKey) ?? 0;
      if (seen >= 2) continue;
      perDocument.set(docKey, seen + 1);
      limited.push(item);
    }
    return limited;
  }

  private enrichGithubKbReferencesWithLocalDocs(
    kbReferences: SearchReference[],
    localDocsReferences: SearchReference[]
  ): SearchReference[] {
    if (!kbReferences.length || !localDocsReferences.length) return kbReferences;
    return kbReferences.map((reference) => {
      const referencePath = this.canonicalDocsPath(reference.path).toLowerCase();
      const referenceHeading = String(reference.headingPath ?? "ROOT").trim().toLowerCase();
      const localMatch = localDocsReferences.find((candidate) => {
        const candidatePath = this.canonicalDocsPath(candidate.path).toLowerCase();
        const candidateHeading = String(candidate.headingPath ?? "ROOT").trim().toLowerCase();
        return candidatePath === referencePath && candidateHeading === referenceHeading;
      });
      if (!localMatch || localMatch.snippet.length <= reference.snippet.length) {
        return reference;
      }
      return {
        ...reference,
        snippet: localMatch.snippet
      };
    });
  }

  private scoreDocKindMatch(reference: SearchReference, requiredDocKinds: string[]): number {
    if (!requiredDocKinds.length) return 0;
    const profile = this.getReferenceProfile(reference);
    const semanticText = this.getReferenceSemanticText(reference);

    let score = 0;
    for (const kind of requiredDocKinds.map((item) => item.toLowerCase())) {
      if (kind === "openapi/api") {
        if (profile.productArea === "openapi") score += 14;
        if (profile.evidenceKind === "api_operation") score += 18;
      }
      else if (kind === "schema" || kind === "field") {
        if (
          /\b(schema|field|fields|property|properties|response|status object)\b|字段|属性|响应/.test(semanticText) ||
          profile.evidenceKind.includes("schema")
        ) score += 16;
      } else if (kind === "syntax_reference") {
        if (/\b(onesql|syntax|query language|reference)\b|语法|查询语言/.test(semanticText)) score += 20;
      } else if (kind === "permissions") {
        if (profile.permissions.length > 0 || /\b(scope|permission|oauth|authorization|authentication)\b/.test(semanticText)) score += 18;
      } else if (kind === "rules") {
        if (profile.evidenceKind === "constraint" || /\b(rule|workflow|behavior|limitation)\b|规则|流程|行为|限制/.test(semanticText)) score += 14;
      } else if (kind === "troubleshooting") {
        if (profile.evidenceKind === "troubleshooting" || /\b(troubleshoot|faq|why|failure|error)\b|排查|故障|失败|报错/.test(semanticText)) score += 12;
      } else if (kind === "product_guide") {
        if (profile.evidenceKind === "procedure" || profile.evidenceKind === "capability") score += 12;
      } else if (kind === "deployment_runbook") {
        if (profile.productArea === "deployment") score += 16;
        if (profile.deploymentModel === "private_deployment") score += 14;
        if (profile.evidenceKind === "procedure" || profile.evidenceKind === "constraint" || profile.evidenceKind === "troubleshooting") {
          score += 10;
        }
      }
    }

    if (profile.productArea === "openapi" && requiredDocKinds.some((item) => item.toLowerCase() === "openapi/api")) {
      score += 4;
    }

    return score;
  }

  private scoreCaseFrameMatch(reference: SearchReference, caseFrame?: SupportCaseFrame): number {
    if (!caseFrame) return 0;
    const profile = this.getReferenceProfile(reference);
    const semanticText = this.getReferenceSemanticText(reference);
    let score = 0;

    if (caseFrame.product_area && caseFrame.product_area !== "general" && caseFrame.product_area !== "unknown") {
      if (profile.productArea === caseFrame.product_area) score += 20;
      else if (profile.productArea) score -= 8;
    }
    if (caseFrame.deployment_model === "private_deployment") {
      if (profile.deploymentModel === "private_deployment" || profile.appliesTo.includes("private_deployment")) score += 18;
      else if (profile.deploymentModel) score -= 8;
    }
    if (String(caseFrame.question_type ?? "").startsWith("api_")) {
      if (profile.productArea === "openapi") score += 10;
      if (profile.evidenceKind === "api_operation") score += 14;
    }
    if (caseFrame.question_type === "how_to_product" || caseFrame.question_type === "config_setup") {
      if (profile.evidenceKind === "procedure") score += 12;
      if (profile.evidenceKind === "troubleshooting") score += 6;
    }
    if (caseFrame.product_area === "deployment" && /\b(unified|shared|external|database|storage|topology|architecture|isolation|separate)\b|统一|外置|数据库|存储|拓扑|架构|隔离|独立/.test(semanticText)) {
      score += 12;
    }

    return score;
  }

  rerankReferencesForRoute(references: SearchReference[], options?: {
    requiredDocKinds?: string[];
    questionType?: string;
    caseFrame?: SupportCaseFrame;
  }): SearchReference[] {
    const requiredDocKinds = options?.requiredDocKinds ?? [];
    const questionType = String(options?.questionType ?? "");
    return [...references].sort((a, b) => {
      const caseFrameDiff = this.scoreCaseFrameMatch(b, options?.caseFrame) - this.scoreCaseFrameMatch(a, options?.caseFrame);
      if (caseFrameDiff !== 0) return caseFrameDiff;

      const docKindDiff = this.scoreDocKindMatch(b, requiredDocKinds) - this.scoreDocKindMatch(a, requiredDocKinds);
      if (docKindDiff !== 0) return docKindDiff;

      if (questionType.startsWith("api_")) {
        const aApi = this.getReferenceProfile(a).productArea === "openapi" || this.getReferenceProfile(a).evidenceKind === "api_operation";
        const bApi = this.getReferenceProfile(b).productArea === "openapi" || this.getReferenceProfile(b).evidenceKind === "api_operation";
        if (aApi !== bApi) return bApi ? 1 : -1;
      }

      return b.score - a.score;
    });
  }

  combineEvidenceCollections(collections: SearchEvidenceCollection[]): SearchEvidenceCollection {
    const validCollections = collections.filter(Boolean);
    const mergedReferences = this.mergeReferences(validCollections.flatMap((item) => item.references)).slice(
      0,
      env.GITHUB_KB_PROFILE_AGENT_TOPK
    );
    const confidence = Math.max(0, ...validCollections.map((item) => item.confidence));
    const fallbackUsed = validCollections.some((item) => item.fallbackUsed);
    const resolvedQueries = [...new Set(validCollections.flatMap((item) => item.resolvedQueries))];
    const primaryQuery = validCollections.find((item) => item.query)?.query ?? "";

    if (!mergedReferences.length) {
      return {
        query: primaryQuery,
        answer: "",
        confidence: 0,
        references: [],
        retrievalStatus: "no_results",
        unresolvedReasonCode: "NO_MATCHING_KB",
        resolvedQueries,
        fallbackUsed
      };
    }

    return {
      query: primaryQuery,
      answer: "",
      confidence,
      references: mergedReferences,
      retrievalStatus: "grounded",
      unresolvedReasonCode: confidence < env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD ? "LOW_CONFIDENCE" : null,
      resolvedQueries,
      fallbackUsed
    };
  }

  async refineEvidence(input: {
    baseQuery: string;
    references: SearchReference[];
    idempotencyKey: string;
    runtime?: OpenClawRuntimeContext;
    answerLanguage?: "zh" | "en";
    attachments?: string[];
    caseFrame?: SupportCaseFrame;
  }): Promise<SearchEvidenceCollection> {
    const normalizedBaseQuery = this.normalizeQuery(input.baseQuery);
    const refinementQueries = this.mergeReferences(input.references)
      .slice(0, 2)
      .map((item) => `${normalizedBaseQuery} ${item.title}`.trim())
      .filter((query) => query && query !== normalizedBaseQuery);

    if (!refinementQueries.length) {
      return this.buildNoResults(normalizedBaseQuery, false);
    }

    return this.collectEvidence({
      queries: refinementQueries,
      idempotencyKey: `${input.idempotencyKey}:refine`,
      runtime: input.runtime,
      answerLanguage: input.answerLanguage,
      attachments: input.attachments,
      caseFrame: input.caseFrame
    });
  }

  normalizeQuery(query: string): string {
    const compact = query.trim().replace(/\s+/g, " ");
    const urlMatch = compact.match(/https?:\/\/[^\s"']+\/openapi\/v2\/[^\s"']+/i);
    if (!urlMatch) return compact;

    const methodMatch = compact.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
    const errorCodeMatch = compact.match(/"errorCode"\s*:\s*"([^"]+)"/i);
    const errorMsgMatch = compact.match(/"errorMsg"\s*:\s*"([^"]+)"/i);
    const statusFieldMatch = compact.match(/"status"\s*:\s*"([^"]+)"/i);

    let pathname = urlMatch[0];
    try {
      const parsed = new URL(urlMatch[0]);
      pathname = `${parsed.pathname}${parsed.search}`;
    } catch {
      pathname = urlMatch[0];
    }

    const signals = [
      methodMatch?.[1]?.toUpperCase(),
      pathname,
      errorCodeMatch?.[1] ? `errorCode ${errorCodeMatch[1]}` : "",
      errorMsgMatch?.[1] ? `errorMsg ${errorMsgMatch[1]}` : "",
      statusFieldMatch?.[1] ? `payload status ${statusFieldMatch[1]}` : "",
      compact.includes('"issueTypeID"') ? "issueTypeID" : "",
      compact.includes('"fieldValues"') ? "fieldValues" : "",
      compact.includes('"watchers"') ? "watchers" : ""
    ]
      .filter(Boolean)
      .join(" ");

    return signals || compact;
  }

  async collectEvidence(input: {
    queries: string[];
    idempotencyKey: string;
    runtime?: OpenClawRuntimeContext;
    answerLanguage?: "zh" | "en";
    attachments?: string[];
    caseFrame?: SupportCaseFrame;
  }): Promise<SearchEvidenceCollection> {
    const queryLimit = Math.max(1, Math.min(4, input.runtime?.queryLimit ?? 4));
    const topK = Math.max(1, Math.min(env.GITHUB_KB_PROFILE_AGENT_TOPK, input.runtime?.kbTopK ?? env.GITHUB_KB_PROFILE_AGENT_TOPK));
    const normalizedQueries = [...new Set(input.queries.map((item) => this.normalizeQuery(item)).filter(Boolean))].slice(0, queryLimit);
    const lang = input.answerLanguage ?? "en";
    if (!env.FEATURE_KB_GROUNDED_SEARCH) {
      return this.buildKbUnavailable(normalizedQueries[0] ?? "");
    }
    if (!normalizedQueries.length) {
      return this.buildNoResults("", false);
    }

    const retrieveOnce = async (query: string) => {
      if (env.NODE_ENV === "test" && /simulate_(?:openclaw|support_agent)_failure/i.test(query)) {
        throw new Error(`KB retrieval unavailable for query: ${query}`);
      }
      if (env.NODE_ENV === "test" && /unresolvable deep investigation request/i.test(query)) {
        return {
          confidence: 0,
          fallbackUsed: false,
          resolvedQueries: [query],
          references: []
        };
      }
      const retrievedAt = new Date().toISOString();
      const toLocalDocsResult = async () => {
        if (input.runtime?.disableLocalDocs) return null;
        const localDocsHits = await searchLocalDocs(query, lang, topK).catch(() => []);
        if (!localDocsHits.length) return null;
        return {
          confidence: localDocsHits[0]?.score || 0,
          fallbackUsed: false,
          resolvedQueries: [query],
          references: localDocsHits.map((hit) =>
            this.toReference(
              {
                documentId: hit.documentId,
                title: hit.title,
                snippet: hit.snippet,
                sourceUrl: hit.sourceUrl,
                repoSourceUrl: hit.repoSourceUrl,
                repo: hit.repo,
                branch: hit.branch,
                path: hit.path,
                commitSha: hit.commitSha,
                headingPath: hit.headingPath,
                supportMetadata: { ...(hit.supportMetadata ?? {}), authority: "canonical_visible", source_type: "local_docs" },
                score: hit.score
              },
              retrievedAt
            )
          )
        };
      };

      const [localDocsResult, kbResult] = await Promise.all([
        toLocalDocsResult().catch(() => null),
        githubKbService
          .retrieveKnowledgeWithRetry({
            query,
            answerLanguage: lang,
            profile: "agent",
            topK,
            includeFallback: true
          })
          .then((kb) => {
            const docsComHits = kb.hits
              .map((hit) =>
                this.toReference(
                  {
                    ...hit,
                    supportMetadata: { ...(hit.supportMetadata ?? {}), authority: "canonical_visible", source_type: "github_kb" }
                  },
                  retrievedAt
                )
              )
              .filter((hit) => this.isDocsComVisibleReference(hit));
            return {
              confidence: docsComHits.length ? kb.confidence : 0,
              fallbackUsed: false,
              resolvedQueries: kb.resolvedQueries ?? [query],
              references: docsComHits
            };
          })
          .catch(() => null)
      ]);

      const kbReferences = kbResult?.references ?? [];
      const localDocsReferences = localDocsResult?.references ?? [];
      const mergedReferences = this.mergeReferences(
        input.runtime?.disableLocalDocs
          ? this.enrichGithubKbReferencesWithLocalDocs(kbReferences, localDocsReferences)
          : [...localDocsReferences, ...this.enrichGithubKbReferencesWithLocalDocs(kbReferences, localDocsReferences)],
        { query }
      );
      const rerankedReferences = this.rerankReferencesForRoute(mergedReferences, {
        requiredDocKinds: input.caseFrame?.required_doc_kinds,
        questionType: input.caseFrame?.question_type,
        caseFrame: input.caseFrame
      });

      if (!rerankedReferences.length) {
        if (!localDocsResult && !kbResult) {
          throw new Error(`KB retrieval unavailable for query: ${query}`);
        }
        return {
          confidence: 0,
          fallbackUsed: false,
          resolvedQueries: [
            ...(localDocsResult?.resolvedQueries ?? []),
            ...(kbResult?.resolvedQueries ?? [query])
          ],
          references: []
        };
      }

      return {
        confidence: Math.max(localDocsResult?.confidence ?? 0, kbResult?.confidence ?? 0),
        fallbackUsed: false,
        resolvedQueries: [
          ...(localDocsResult?.resolvedQueries ?? []),
          ...(kbResult?.resolvedQueries ?? [query])
        ],
        references: rerankedReferences
      };
    };

    const firstRound = await Promise.all(normalizedQueries.map((query) => retrieveOnce(query)));
    const merged = this.rerankReferencesForRoute(this.mergeReferences(firstRound.flatMap((item) => item.references), {
      query: normalizedQueries.join(" ")
    }), {
      requiredDocKinds: input.caseFrame?.required_doc_kinds,
      questionType: input.caseFrame?.question_type,
      caseFrame: input.caseFrame
    }).slice(0, env.GITHUB_KB_PROFILE_AGENT_TOPK);
    const confidence = Math.max(0, ...firstRound.map((item) => item.confidence));
    const fallbackUsed = firstRound.some((item) => item.fallbackUsed);
    const resolvedQueries = [...new Set(firstRound.flatMap((item) => item.resolvedQueries))];

    if (!merged.length) {
      return this.buildNoResults(normalizedQueries[0], fallbackUsed, resolvedQueries);
    }

    return {
      query: normalizedQueries[0],
      answer: "",
      confidence,
      references: merged,
      retrievalStatus: "grounded",
      unresolvedReasonCode: confidence < env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD ? "LOW_CONFIDENCE" : null,
      resolvedQueries,
      fallbackUsed
    };
  }

  async search(
    query: string,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext,
    answerLanguage?: "zh" | "en",
    attachments: string[] = []
  ): Promise<SearchResponseEnvelope> {
    const normalized = this.normalizeQuery(query);
    const lang = answerLanguage ?? "en";
    const msg = {
      disabled:
        lang === "zh"
          ? "知识库检索当前已关闭，请直接提交工单获取支持。"
          : "Knowledge grounding is temporarily disabled. Please submit a ticket for support.",
      noMatch:
        lang === "zh"
          ? "未找到可验证的相关知识文档。请使用快速提单进入深度检索。"
          : "I could not find a verified knowledge article for this issue. Please use quick ticket escalation.",
      lowConfidence:
        lang === "zh"
          ? "找到了一些相关文档，但当前证据置信度不足。建议使用快速提单进行深度检索。"
          : "I found potentially related documents but confidence is low. Please use quick ticket escalation for deeper retrieval.",
      kbUnavailable:
        lang === "zh"
          ? "知识库检索当前不可用，请使用快速提单。"
          : "Knowledge retrieval is currently unavailable. Please use quick ticket escalation."
    };

    if (!env.FEATURE_KB_GROUNDED_SEARCH) {
      return {
        query: normalized,
        answer: msg.disabled,
        confidence: 0,
        references: [],
        retrievalStatus: "kb_unavailable",
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE"
      };
    }
    try {
      const evidence = await this.collectEvidence({
        queries: [normalized],
        idempotencyKey,
        runtime,
        answerLanguage: lang,
        attachments
      });
      if (!evidence.references.length) {
        return {
          ...evidence,
          answer: msg.noMatch
        };
      }
      return {
        query: evidence.query,
        answer: evidence.unresolvedReasonCode === "LOW_CONFIDENCE" ? msg.lowConfidence : evidence.answer || msg.noMatch,
        confidence: evidence.confidence,
        references: evidence.references,
        retrievalStatus: evidence.retrievalStatus,
        unresolvedReasonCode: evidence.unresolvedReasonCode
      };
    } catch {
      return {
        query: normalized,
        answer: msg.kbUnavailable,
        confidence: 0,
        references: [],
        retrievalStatus: "kb_unavailable",
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE"
      };
    }
  }
}
