import { env } from "../../config/env.js";
import type { OpenClawAdapter } from "../../infrastructure/openclaw/types.js";
import type { SearchReference, SearchResponseEnvelope } from "./types.js";

export class SearchOrchestrator {
  constructor(private readonly adapter: OpenClawAdapter) {}

  normalizeQuery(query: string): string {
    return query.trim().replace(/\s+/g, " ");
  }

  async search(query: string, idempotencyKey: string): Promise<SearchResponseEnvelope> {
    const normalized = this.normalizeQuery(query);

    if (!env.FEATURE_KB_GROUNDED_SEARCH) {
      return {
        query: normalized,
        answer: "Knowledge grounding is temporarily disabled. Please submit a ticket for support.",
        confidence: 0,
        references: [],
        retrievalStatus: "kb_unavailable",
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE"
      };
    }

    try {
      const result = await this.adapter.searchKnowledge(
        {
          query: normalized,
          topK: env.OPENCLAW_SEARCH_TOP_K,
          index: env.OPENCLAW_SEARCH_INDEX
        },
        idempotencyKey
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
          answer: "I could not find a verified knowledge article for this issue. Please use quick ticket escalation.",
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
          answer: "I found potentially related documents but confidence is low. Please use quick ticket escalation for deeper retrieval.",
          confidence: topConfidence,
          references,
          retrievalStatus: "no_results",
          unresolvedReasonCode: "LOW_CONFIDENCE"
        };
      }

      return {
        query: normalized,
        answer: `Based on \"${references[0].title}\", follow the referenced steps. If unresolved, use quick ticket escalation for agent deep retrieval.`,
        confidence: topConfidence,
        references,
        retrievalStatus: "grounded",
        unresolvedReasonCode: null
      };
    } catch {
      return {
        query: normalized,
        answer: "Knowledge retrieval is currently unavailable. Please use quick ticket escalation.",
        confidence: 0,
        references: [],
        retrievalStatus: "kb_unavailable",
        unresolvedReasonCode: "KB_RETRIEVAL_UNAVAILABLE"
      };
    }
  }
}
