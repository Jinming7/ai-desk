# AI Support Reranker Integration Plan

Date: 2026-04-01

Status: proposed

Scope:

- evaluate whether a reranker should be added to the TicketManagement support retrieval stack
- prioritize `bge-reranker`, especially `bge-reranker-v2-m3`
- define the safest integration point under the existing Part 04 and Part 05 architecture
- define downgrade rules, config surface, evaluation method, and implementation order

This document is intentionally limited to design.

It does not approve production cutover.

It does not replace the existing rebuild contracts in Part 01, Part 03, Part 04, or Part 05.

---

## 1. Conclusion

### 1.1 Is it worth adding

Yes, it is worth adding a reranker.

But it should be added as a `second-stage semantic rerank enhancement`, not as a replacement for the current retrieval architecture.

The current system already has:

- exact-signal recall
- sparse recall
- dense recall
- structured artifact recall
- fusion
- feature rerank
- grounding
- evidence gate

So the missing capability is not "having rerank at all".

The missing capability is:

- a stronger semantic pairwise relevance judge after fusion and feature scoring
- especially for multilingual, phrasing-mismatch, wrong-family ordering, and support-intent disambiguation

### 1.2 Most recommended integration point

The recommended placement is:

1. recall channels
2. fusion
3. existing feature rerank
4. `bge-reranker`
5. grounding
6. evidence gate

In short:

- `fusion after` and `grounding before`
- more precisely: `after feature rerank`, not `instead of feature rerank`

### 1.3 Why this is the best placement

Because the current feature rerank already carries architectural constraints that a cross-encoder should not replace:

- case-frame fit
- required doc kind fit
- object type fit
- product area fit
- deployment model fit
- citation availability
- degraded parser penalty
- build consistency

Those are system-guardrail signals, not just semantic relevance signals.

`bge-reranker` should refine semantic ordering inside a constrained shortlist.

It should not become the only judge of retrieval quality.

### 1.4 Recommendation summary

Recommended:

- keep current feature rerank
- add `bge-reranker` as optional semantic rerank on top of feature-shortlisted candidates
- default it behind a feature flag
- treat failure as `skip semantic rerank and continue`

Not recommended:

- replacing feature rerank entirely
- reranking after grounding
- bypassing grounding and outputting citations directly from reranker results
- using reranker as a band-aid for recall defects

---

## 2. Current System Analysis

### 2.1 Frozen architecture constraints that must not be violated

From Part 01, Part 03, Part 04, and Part 05, the following are non-negotiable:

1. the system is an `AI-driven support engineer agent`, not a search box
2. retrieval is only a subsystem of the support agent
3. runtime retrieval must read from one published snapshot only
4. retrieval units and citation units are distinct
5. rerank must happen before grounding
6. customer-facing answers must not be composed from retrieval units alone
7. evidence gate must remain in force

This directly constrains reranker placement.

Any reranker design that:

- mixes builds
- ranks unpublished artifacts
- directly selects final customer citations
- or bypasses grounding

is invalid.

### 2.2 Where rerank already exists today

The new hybrid runtime already implements:

1. multi-channel recall
2. weighted reciprocal rank fusion
3. feature rerank
4. grounding
5. evidence gate

Current relevant files:

- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/hybrid-retrieval.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/hybrid-retrieval-provider.ts`
- `/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/hybrid-retrieval-types.ts`

Current rerank in `hybrid-retrieval.ts` is feature-based and uses:

- channel agreement
- exact signal overlap
- citation availability
- case-frame fit
- doc kind fit
- object type fit
- degraded parser penalty

This is aligned with Part 04's "rule-light feature rerank first" design.

### 2.3 Where the current system is still weak

The main current weakness is not missing stages.

It is that the semantic quality of the current rerank layer is still limited.

That weakness is most visible when:

- multiple candidates are all plausible at metadata level
- the top results come from the right broad family but wrong sub-family
- the user phrasing is multilingual or far from repository wording
- symptom-driven troubleshooting has high lexical noise
- structured artifacts and memory abstractions both look plausible and need finer semantic arbitration

The repository review also already identified that older paths still rely too much on lexical/path heuristics.

That means a semantic reranker can help, but only if it is inserted into the new hybrid runtime rather than layered onto the old heuristic path.

### 2.4 What is missing in the repository today

The repository currently does not have:

- reranker env/config
- reranker provider abstraction
- reranker API client
- reranker diagnostics
- reranker-specific tests

It also does not yet have:

- a semantic rerank score blended with feature rerank
- skip logic for rerank-worth cases
- latency or cost controls for reranker calls

### 2.5 Old path vs new path

The repository currently has two realities:

1. new hybrid retrieval runtime behind `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL`
2. older orchestration and heuristic rerank paths still present

The reranker proposal should target the new hybrid runtime only.

It should not be added first to the old path-heavy route-aware sorters.

Otherwise the project risks reinforcing the old retrieval surface instead of the Part 04 architecture.

---

## 3. Integration Plan

### 3.1 Stage position

The recommended stage position is:

1. channel recall
2. candidate normalization
3. fusion
4. feature rerank
5. semantic rerank with `bge-reranker`
6. grounding
7. evidence gate

This matches the Part 04 contract:

- retrieval-unit recall
- retrieval-unit rerank
- grounding to citation units
- citation validation

`bge-reranker` therefore belongs inside the `retrieval-unit rerank` stage, not outside it.

### 3.2 Why not put it after grounding

Putting rerank after grounding is not recommended for this project because:

1. the Part 03 flow is retrieval-unit rerank first, grounding later
2. grounding is more expensive than reranking a shortlist
3. if reranking waits until after grounding, the system spends grounding budget on candidates that should have been rejected earlier
4. it blurs the retrieval-unit vs citation-unit boundary

Post-grounding display-citation ordering can exist later as a separate concern, but that is not the primary reranker integration point.

### 3.3 Why not replace the current feature rerank

This is not recommended.

Reasons:

1. feature rerank carries support-specific constraints that the cross-encoder does not know explicitly
2. build consistency, citation availability, and deployment/doc-kind alignment are architecture guards, not optional hints
3. cross-encoders are excellent at semantic relevance, but they are not the right single source of truth for serving-policy constraints

Therefore the semantic reranker should be an additional signal layered on top of feature rerank.

### 3.4 What objects should be reranked

Recommended answer:

- rerank `mixed normalized candidates`, but with retrieval abstractions as the primary target

Concretely this means the reranker input set may contain:

- `memory` candidates
- `artifact` candidates
- `citation` candidates
- `chunk` candidates

But the intended semantic decision is still:

- which retrieval abstractions are most relevant for the support case

This preserves the Part 03 distinction:

- retrieval units are for intent matching
- citation units are for grounding and final evidence

### 3.5 Candidate policy by object type

Recommended handling:

#### A. `memory` candidates

These should be the primary rerank target.

Why:

- they are the repository's first-class retrieval abstraction layer
- they encode support-friendly semantic normalization
- they are exactly what Part 04 says should be matched first

#### B. `artifact` candidates

These should also be reranked.

Why:

- structured artifacts often carry precise API/config/behavior meaning
- they are high-value for API, config, behavior, and troubleshooting queries

#### C. `citation` and `chunk` candidates

These may participate in semantic rerank if they are already present in the normalized shortlist.

But they should not become the dominant object type for rerank design.

They remain grounding targets first.

#### D. Final recommendation

Use mixed candidates in the shortlist.

But make the reranker integration conceptually a:

- `retrieval-unit semantic rerank`

not a:

- `citation-only rerank`

### 3.6 Candidate text serialization

Do not pass raw snippet alone.

The reranker should receive a compact serialized candidate text that preserves the candidate's support-relevant identity.

Recommended serialized fields:

- `title`
- `snippet`
- `candidate_family`
- `doc_kind`
- `object_type`
- `product_area`
- `deployment_model`
- selected exact-match fields

Recommended formatting:

- compact YAML or compact JSON-like text

Example shape:

```yaml
title: GitHub callback troubleshooting
family: troubleshooting_pattern
doc_kind: troubleshooting
object_type: redirect uri
product_area: integrations
deployment_model: shared
evidence_summary: Callback redirects must exactly match the configured redirect URI.
matched_fields:
  - redirect_uri
  - page_text
```

Why:

- it helps the reranker distinguish between candidate families
- it supports semi-structured ranking, which industry rerank APIs commonly support well
- it avoids over-relying on path names or raw chunk text

### 3.7 Scoring strategy

For MVP, do not let reranker score fully overwrite the feature rerank score.

Recommended blended strategy:

```text
final_pre_ground_score =
  0.65 * feature_rerank_score +
  0.35 * semantic_rerank_score_normalized
```

Why this is the best starting point:

1. feature rerank stays the architecture guardrail
2. semantic rerank still has enough influence to fix wrong ordering
3. regressions are easier to contain

Alternative weights can be explored later, but do not start with semantic-overwrite mode.

### 3.8 Provider model recommendation

Primary model recommendation:

- `BAAI/bge-reranker-v2-m3`

Why this model fits the project:

1. multilingual
2. lightweight compared with larger LLM-style rerankers
3. good fit for Chinese + English mixed support queries
4. appropriate for query-passage cross-encoding
5. better deployment practicality than larger instruction rerankers for first integration

This is also consistent with the model's stated positioning:

- multilingual
- lightweight
- easy to deploy
- fast inference

### 3.9 Provider abstraction

Recommended abstraction shape:

- a dedicated `SemanticReranker` interface used only by `HybridRetrievalRuntime`

Suggested conceptual methods:

```ts
interface SemanticReranker {
  rerank(input: {
    query: string;
    candidates: Array<{
      candidateId: string;
      text: string;
      candidateType: string;
      candidateFamily: string;
    }>;
    topN: number;
  }): Promise<Array<{
    candidateId: string;
    score: number;
  }>>;
}
```

Do not hide this behind the existing embedding provider.

Rerank and embedding are different capabilities with different latency and failure semantics.

### 3.10 Provider options

Recommended provider order:

1. `custom_http`
2. hosted inference provider adapter
3. optional local self-hosted adapter later

For this repository, the first implementation should be HTTP-based from Node.

Do not make Python FlagEmbedding an in-process requirement for MVP.

Reasons:

1. the current repository already uses HTTP-style external model calls for embeddings
2. env/config and operational behavior will be easier to control
3. timeouts, retries, and fallback handling are simpler
4. it avoids coupling the API runtime to local Python/GPU assumptions

### 3.11 Env / config / feature flag design

Recommended new env variables:

```env
FEATURE_SUPPORT_AGENT_SEMANTIC_RERANK=false
GITHUB_KB_RERANKER_PROVIDER=custom_http
GITHUB_KB_RERANKER_API_BASE=
GITHUB_KB_RERANKER_API_KEY=
GITHUB_KB_RERANKER_MODEL=BAAI/bge-reranker-v2-m3
GITHUB_KB_RERANKER_TIMEOUT_MS=800
GITHUB_KB_RERANKER_MAX_RETRIES=1
GITHUB_KB_RERANKER_TOPN=12
GITHUB_KB_RERANKER_SCORE_WEIGHT=0.35
GITHUB_KB_RERANKER_MIN_CANDIDATES=4
GITHUB_KB_RERANKER_MAX_TEXT_CHARS=1200
GITHUB_KB_RERANKER_ALLOWED_QUERY_TYPES=api,troubleshooting,config_setup,why_behavior,capability_confirmation
```

Purpose of each:

- `FEATURE_SUPPORT_AGENT_SEMANTIC_RERANK`: master enable flag
- `GITHUB_KB_RERANKER_PROVIDER`: provider selection
- `GITHUB_KB_RERANKER_API_BASE`: provider base URL
- `GITHUB_KB_RERANKER_API_KEY`: auth
- `GITHUB_KB_RERANKER_MODEL`: model name
- `GITHUB_KB_RERANKER_TIMEOUT_MS`: request timeout
- `GITHUB_KB_RERANKER_MAX_RETRIES`: small retry budget
- `GITHUB_KB_RERANKER_TOPN`: max candidates to rerank
- `GITHUB_KB_RERANKER_SCORE_WEIGHT`: blend weight
- `GITHUB_KB_RERANKER_MIN_CANDIDATES`: skip threshold
- `GITHUB_KB_RERANKER_MAX_TEXT_CHARS`: candidate serialization cap
- `GITHUB_KB_RERANKER_ALLOWED_QUERY_TYPES`: gating for worthy queries

### 3.12 Compatibility with publication-based serving

This design is compatible with publication-based serving because:

1. reranker does not fetch new rows directly from the DB
2. all candidates fed into rerank are already filtered to one `published_build_version`
3. grounding remains publication-bound after rerank

Therefore:

- reranker can reorder within one build snapshot
- reranker cannot widen visibility
- reranker cannot accidentally publish or expose unpublished artifacts

### 3.13 Compatibility with grounding and evidence gate

This design preserves both:

#### Grounding remains mandatory

The reranker returns only reordered candidate ids and scores.

It does not emit final citations.

#### Evidence gate remains mandatory

If reranked candidates do not ground successfully, the evidence gate still rejects them.

This is essential.

The reranker must not be allowed to turn ungrounded semantic plausibility into answerable evidence.

### 3.14 Failure downgrade strategy

Recommended downgrade rule:

- any reranker failure becomes `semantic_rerank_skipped`
- then continue with the current feature-rerank order

Do not convert reranker failure into:

- `kb_unavailable`
- `no_results`
- forced handoff

because the retrieval system itself may still be working correctly.

#### Failure classes and handling

1. provider unavailable
   - log diagnostics
   - skip rerank
   - continue with feature-rerank order

2. key missing
   - treat as disabled
   - skip rerank silently except diagnostics

3. timeout
   - skip rerank for that request
   - do not block grounding

4. quota / rate limit
   - skip rerank
   - optionally backoff for subsequent requests if future runtime control is added

5. malformed provider response
   - skip rerank
   - retain original order

Recommended diagnostic reason codes:

- `semantic_rerank_disabled`
- `semantic_rerank_missing_key`
- `semantic_rerank_timeout`
- `semantic_rerank_provider_error`
- `semantic_rerank_rate_limited`
- `semantic_rerank_invalid_response`

---

## 4. Performance And Cost Control

### 4.1 Default topN

Recommended MVP default:

- rerank only feature-rerank `top 12`

Hard upper bound:

- `16`

Do not rerank the full fused candidate set.

The whole point of cross-encoder reranking is:

- expensive precision on a small shortlist

not:

- second-pass scoring of the entire recall set

### 4.2 Candidate-count gating

Skip semantic rerank when:

1. candidate count is less than `4`
2. top-1 feature score is much larger than top-2 and the winner already has strong exact-signal and citation availability
3. only one coherent family is present and grounding likelihood is already high

This prevents paying latency when reranking is unlikely to change anything meaningful.

### 4.3 Query-type gating

Most valuable query types:

1. `api_*`
2. `config_setup`
3. `troubleshooting`
4. `why_behavior`
5. `capability_confirmation`

Least valuable early targets:

1. very direct how-to product questions with obvious procedure hits
2. narrow exact-identifier lookup where exact-signal already dominates and family ambiguity is low

### 4.4 Timeout budget

Recommended timeout:

- default `800ms`

If using a close hosted endpoint or same-region deployment:

- `400-600ms` may be realistic later

If timeout is reached:

- stop waiting
- skip rerank
- continue with existing order

Do not let reranker latency block the retrieval runtime excessively.

### 4.5 Retry budget

Recommended MVP:

- at most `1` retry
- preferably only for connection/reset classes

Do not retry on every timeout or `429`.

This is a quality enhancer, not a hard dependency.

### 4.6 Serialization length control

Because rerankers operate on query-document pairs, candidate serialization must be length-bounded.

Recommended cap:

- `800-1200` characters per candidate text

Include:

- title
- family and typed metadata
- short evidence summary

Exclude:

- full chunks
- large raw schemas
- large code blocks

### 4.7 Cost control principle

The system should spend reranker budget only where it has a realistic chance to change:

- top family ordering
- abstraction selection
- grounding success likelihood

It should not be invoked as a blanket default over every search request.

---

## 5. Evaluation And Acceptance

### 5.1 Evaluation goal

The question is not:

- "does reranker make one demo query look better"

The real question is:

- "does reranker improve retrieval-unit ordering and grounding quality without violating architecture guarantees"

### 5.2 A/B design

Recommended offline and staged evaluation:

#### Variant A

- current hybrid runtime
- fusion + feature rerank only

#### Variant B

- current hybrid runtime
- fusion + feature rerank + `bge-reranker`

Optional later:

#### Variant C

- same as B but with different blend weight or candidate serialization

### 5.3 Primary metrics

Recommended metrics:

1. retrieval-unit `top1` hit rate
2. retrieval-unit `top3` hit rate
3. grounded citation `top1` hit rate
4. grounded citation `top3` hit rate
5. citation grounding rate
6. evidence gate grounded rate
7. wrong-family at top1
8. wrong-family at top3
9. no-results rate
10. handoff / clarification fallback rate
11. reranker latency p50 / p95
12. reranker skip/error rate

### 5.4 Most important qualitative metric

One especially important project-specific metric:

- whether `wrong-family` ranking decreases

Examples:

- generic API docs outranking troubleshooting
- generic capability docs outranking deployment runbook
- broad doc pages outranking exact config or artifact evidence

This project's failure mode is often not "nothing retrieved".

It is:

- "plausible but wrong family ranked too high"

That is exactly where semantic reranking should prove value.

### 5.5 Business-case eval set

At minimum evaluate:

1. API field lookup
2. API scope/auth lookup
3. config/setup issue
4. troubleshooting symptom query
5. behavior/rule/limitation query
6. deployment architecture / shared-vs-isolated backend question

These are already aligned with repository evaluation plans and observed failure cases.

### 5.6 Acceptance criteria

Recommended acceptance criteria for adding the reranker to the codebase behind a feature flag:

1. no violation of publication-based serving
2. no violation of grounding-first evidence policy
3. no increase in memory-only ungrounded answers
4. `wrong-family@1` decreases on target eval cases
5. top1 or top3 hit rate improves in at least troubleshooting and API/config families
6. citation grounding rate does not regress
7. p95 reranker latency stays within the allowed budget
8. reranker failures degrade cleanly to the feature-rerank baseline

### 5.7 Tests to add

Recommended focused tests:

1. semantic rerank skipped when feature flag is off
2. semantic rerank skipped when provider config is missing
3. timeout falls back to feature-rerank order
4. provider error falls back to feature-rerank order
5. reranked output still grounds only to the published build
6. evidence gate still rejects ungrounded memory-only cases after semantic rerank
7. semantic rerank can move a correct artifact or memory candidate above a generic wrong-family candidate

---

## 6. Implementation Order

### 6.1 Smallest safe MVP

Recommended MVP order:

1. add env/config schema
2. add reranker provider abstraction
3. add one HTTP provider implementation
4. add candidate serialization helper
5. insert semantic rerank step after feature rerank and before grounding
6. blend semantic score with feature score
7. add diagnostics and fallback reason codes
8. add focused tests

This is the smallest safe version that produces meaningful evidence.

### 6.2 What should be done first

Can be done first:

1. provider interface
2. env/config
3. diagnostics
4. no-op fallback path

These create the safe scaffolding before any actual rerank call is made.

### 6.3 What must come after MVP

Recommended later enhancements:

1. query-type-aware rerank gating
2. dynamic topN selection
3. better candidate serialization per family
4. score-weight tuning
5. provider-specific adapters beyond `custom_http`
6. deeper evaluation harness and trace integration

### 6.4 What should not be included in this phase

Explicitly out of scope for this phase:

1. production cutover
2. replacing the old retrieval path entirely
3. using reranker as a direct citation selector
4. reranking after grounding as the main design
5. fine-tuning a custom reranker model
6. large topology changes in OpenClaw stages

### 6.5 Final implementation recommendation

The best phased approach is:

#### Phase A. Safe scaffolding

- config
- provider
- diagnostics
- skip/fallback behavior

#### Phase B. MVP semantic rerank

- feature shortlist -> `bge-reranker` -> blended score -> grounding

#### Phase C. Evaluation hardening

- A/B on fixed support eval set
- inspect wrong-family reduction
- inspect grounding rate and fallback behavior

#### Phase D. Selective optimization

- query gating
- topN tuning
- serialization tuning

---

## Final Recommendation

Add `bge-reranker-v2-m3` as an optional semantic rerank stage inside the new hybrid retrieval runtime.

Do it:

- after fusion
- after the existing feature rerank
- before grounding

Rerank mixed normalized candidates, but treat the stage conceptually as retrieval-unit rerank, not citation-unit answer selection.

Keep publication filtering, grounding, and evidence gate exactly as they are.

On any reranker failure, skip it and fall back to the current feature-rerank output.

This gives the project the most likely quality gain with the lowest architecture risk.

---

## External References

Primary references used for this design:

1. BAAI official model card for `bge-reranker-v2-m3`
   - https://huggingface.co/BAAI/bge-reranker-v2-m3

2. Qdrant official FastEmbed reranker tutorial
   - https://qdrant.tech/documentation/fastembed/fastembed-rerankers/

3. Pinecone official rerank API reference
   - https://docs.pinecone.io/reference/api/latest/inference/rerank

4. Cohere official reranking guide
   - https://docs.cohere.com/docs/reranking-with-cohere
