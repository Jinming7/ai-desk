import { env } from "../../config/env.js";
import type { OpenClawAdapter, OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";
import * as githubKbService from "../github-kb/service.js";
import { searchLocalDocs } from "./local-docs.js";
import type { SearchReference, SearchResponseEnvelope } from "./types.js";

type SearchEvidenceCollection = SearchResponseEnvelope & {
  resolvedQueries: string[];
  fallbackUsed: boolean;
};

export class SearchOrchestrator {
  constructor(private readonly adapter: OpenClawAdapter) {}

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

  private mergeReferences(references: SearchReference[]): SearchReference[] {
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
      if (!previous || item.score > previous.score) {
        byKey.set(key, item);
      }
    }
    const sorted = [...byKey.values()].sort((a, b) => b.score - a.score);
    const topScore = sorted[0]?.score ?? 0;
    const scoreFloor = topScore > 0 ? Math.max(0.25, Number((topScore * 0.6).toFixed(2))) : 0;
    const perDocument = new Map<string, number>();
    const limited: SearchReference[] = [];
    for (const item of sorted) {
      if (limited.length >= 3 && item.score < scoreFloor) continue;
      const docKey = item.path || item.documentId || item.sourceUrl || item.title;
      const seen = perDocument.get(docKey) ?? 0;
      if (seen >= 2) continue;
      perDocument.set(docKey, seen + 1);
      limited.push(item);
    }
    return limited;
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
      attachments: input.attachments
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

      const localDocsResult = await toLocalDocsResult();
      if (localDocsResult) {
        return localDocsResult;
      }

      try {
        const kb = await githubKbService.retrieveKnowledgeWithRetry({
          query,
          answerLanguage: lang,
          profile: "agent",
          topK,
          includeFallback: true
        });
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
        if (!docsComHits.length) {
          return {
            confidence: 0,
            fallbackUsed: false,
            resolvedQueries: kb.resolvedQueries ?? [query],
            references: []
          };
        }
        return {
          confidence: kb.confidence,
          fallbackUsed: false,
          resolvedQueries: kb.resolvedQueries ?? [query],
          references: docsComHits
        };
      } catch {
        throw new Error(`KB retrieval unavailable for query: ${query}`);
      }
    };

    const firstRound = await Promise.all(normalizedQueries.map((query) => retrieveOnce(query)));
    const merged = this.mergeReferences(firstRound.flatMap((item) => item.references)).slice(0, env.GITHUB_KB_PROFILE_AGENT_TOPK);
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
