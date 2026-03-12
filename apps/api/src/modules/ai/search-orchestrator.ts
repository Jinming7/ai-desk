import { env } from "../../config/env.js";
import type { OpenClawAdapter, OpenClawRuntimeContext } from "../../infrastructure/openclaw/types.js";
import * as githubKbService from "../github-kb/service.js";
import type { SearchReference, SearchResponseEnvelope } from "./types.js";

export class SearchOrchestrator {
  constructor(private readonly adapter: OpenClawAdapter) {}

  normalizeQuery(query: string): string {
    return query.trim().replace(/\s+/g, " ");
  }

  async search(
    query: string,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext,
    answerLanguage?: "zh" | "en"
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

    // Primary path: retrieve from local GitHub KB index.
    // Keep this path independent from GITHUB_KB_ENABLED runtime toggle:
    // that toggle controls sync workers, while search should still use
    // already indexed KB data whenever available.
    // OpenClaw retrieval is kept as fallback only when local retrieval throws.
    try {
      const result = await githubKbService.retrieveKnowledgeWithRetry({
        query: normalized,
        answerLanguage: lang,
        profile: "search",
        topK: env.OPENCLAW_SEARCH_TOP_K,
        includeFallback: true
      });

      const references: SearchReference[] = result.hits.map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        snippet: hit.snippet,
        sourceUrl: hit.sourceUrl,
        score: hit.score,
        retrievedAt: new Date().toISOString()
      }));

      if (!references.length) {
        return {
          query: normalized,
          answer: msg.noMatch,
          confidence: 0,
          references: [],
          retrievalStatus: "no_results",
          unresolvedReasonCode: "NO_MATCHING_KB"
        };
      }

      if (result.confidence < env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD) {
        return {
          query: normalized,
          answer: msg.lowConfidence,
          confidence: result.confidence,
          references,
          retrievalStatus: "no_results",
          unresolvedReasonCode: "LOW_CONFIDENCE"
        };
      }

      return {
        query: normalized,
        answer: result.answer || `Based on \"${references[0].title}\", follow the referenced steps.`,
        confidence: result.confidence,
        references,
        retrievalStatus: "grounded",
        unresolvedReasonCode: null
      };
    } catch {
      // continue to OpenClaw fallback below
    }

    try {
      const result = await this.adapter.searchKnowledge(
        {
          query: normalized,
          topK: env.OPENCLAW_SEARCH_TOP_K,
          index: env.OPENCLAW_SEARCH_INDEX
        },
        idempotencyKey,
        runtime
      );

      const retrievedAt = new Date().toISOString();
      const references: SearchReference[] = result.hits.map((hit) => ({
        documentId: hit.id,
        title: hit.title,
        snippet: hit.snippet,
        sourceUrl: hit.sourceUrl,
        score: hit.score,
        retrievedAt
      }));

      if (!references.length) {
        return {
          query: normalized,
          answer: msg.noMatch,
          confidence: 0,
          references: [],
          retrievalStatus: "no_results",
          unresolvedReasonCode: "NO_MATCHING_KB"
        };
      }

      const topConfidence = result.confidence || references[0].score;
      if (topConfidence < env.AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD) {
        return {
          query: normalized,
          answer: msg.lowConfidence,
          confidence: topConfidence,
          references,
          retrievalStatus: "no_results",
          unresolvedReasonCode: "LOW_CONFIDENCE"
        };
      }

      return {
        query: normalized,
        answer:
          lang === "zh"
            ? `已定位相关文档「${references[0].title}」，请按步骤执行；若仍未解决，可使用快速提单进入深度检索。`
            : `Based on "${references[0].title}", follow the referenced steps. If unresolved, use quick ticket escalation for agent deep retrieval.`,
        confidence: topConfidence,
        references,
        retrievalStatus: "grounded",
        unresolvedReasonCode: null
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
