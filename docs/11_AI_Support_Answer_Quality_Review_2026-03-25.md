# AI Support Answer Quality Review

Date: 2026-03-25

Scope: review the current `support` answer pipeline from routing through retrieval, evidence selection, verification, and customer answer composition, with emphasis on the reported failures for both API and non-API questions.

## Executive Summary

The current `support` answer quality problem is not a single bug. It is a pipeline problem:

1. First-pass retrieval starts before the support case is stabilized.
2. Retrieval and rerank are still heavily driven by query-specific regex and path/file heuristics.
3. Non-API questions do not have strict evidence eligibility rules, so noisy documents remain in the candidate set.
4. Verification and citation binding happen too late to recover from a polluted candidate set.
5. The current local uncommitted patch introduces additional hardcoded logic and does not satisfy the "no hardcoding by query/path" requirement.

This affects both API and non-API questions. API is not "fixed"; it only has more explicit constraints than non-API, so some API scenarios look better, but current local tests still show API regressions.

## Review Inputs

Reviewed files:

- `apps/api/src/modules/ai/support-agent.ts`
- `apps/api/src/modules/ai/search-orchestrator.ts`
- `apps/api/src/modules/ai/local-docs.ts`
- `apps/api/src/modules/github-kb/service.ts`
- `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- `apps/api/src/modules/ai/support-agent.test.ts`
- `apps/api/src/modules/ai/search-orchestrator.test.ts`

Runtime verification performed:

- `node --loader tsx --test apps/api/src/modules/ai/support-agent.test.ts`
- `node --loader tsx --test apps/api/src/modules/ai/search-orchestrator.test.ts`

Results:

- `search-orchestrator.test.ts`: pass
- `support-agent.test.ts`: 23 tests, 20 pass, 3 fail

Current support-agent test failures:

1. `runSupportSearchAgent uses fast multi-agent path for grounded how-to answers`
2. `runSupportSearchAgent uses AI stage budget to skip specialist and emit a claim graph`
3. `runSupportSearchAgent recovers grounded API field claims from project list evidence when specialist claims are empty`

The third failure is directly relevant to current API answer-quality complaints because it degrades an API field lookup into `handoff`.

## User-Reported Real Failure

Reported query:

`since we’re considering an self-hosted deployment ... whether requirements and issues share the same backend services and database or can they be isolated ...`

Observed bad output:

- `deployment_model = "shared"`
- `product_area = "general"`
- `required_doc_kinds` polluted with `openapi/api` and `syntax_reference`
- top references include irrelevant docs such as `Azure AD & ONES.com`
- `citations = []`
- `verification.claim_to_citation_map = []`
- final mode becomes `handoff`

This is consistent with a retrieval/routing failure, not an answer-composer wording issue.

## Findings

### P0. First-pass retrieval starts before route/case-frame stabilization

Code:

- `apps/api/src/modules/ai/support-agent.ts#L2750-L2813`

Details:

- `routeSupportQuestion()` and `planSupportEvidence()` run first.
- `planSupportCase()` starts.
- `baseEvidencePromise` then immediately starts retrieval using only the raw `input.query`.
- Only after retrieval returns does the code merge planner output, route output, and evidence plan, then call `stabilizeSupportRouteAndCaseFrame()`.

Impact:

- First-round retrieval is not conditioned on the stabilized `caseFrame`, `question_type`, `product_area`, `deployment_model`, or `required_doc_kinds`.
- Wrong first-round hits contaminate the candidate pool and force later stages to recover from bad evidence instead of preventing it.
- This explains why irrelevant documents can surface at the top even when later stages know the question is really about deployment or a specific API object.

Assessment:

- This is the primary structural root cause.

### P0. Current local patch still uses hardcoded query buckets and path-prefix logic

Code:

- `apps/api/src/modules/ai/support-agent.ts#L197-L223`
- `apps/api/src/modules/ai/support-agent.ts#L244-L340`
- `apps/api/src/modules/ai/support-agent.ts#L2092-L2178`

Details:

- `analyzeSupportQuerySignals()` adds more regex buckets for private deployment, architecture, isolation, and infra wording.
- `stabilizeSupportRouteAndCaseFrame()` adds hardcoded retrieval seed strings and hardcoded `required_doc_kinds` replacement for deployment architecture questions.
- `recoverEvidenceAnchoredDeploymentBehaviorDraft()` selects deployment references with `canonicalDocsPath(reference.path).startsWith("deploy-docs/")`.

Impact:

- The current local patch is still query-pattern-driven and path-driven.
- It may improve one reported query, but it does not generalize.
- It directly violates the requirement to avoid hardcoding by query/path/doc-folder.

Assessment:

- This patch direction should not be pushed as the final fix.

### P0. Shared retrieval layers still contain path/file heuristics, not metadata-first ranking

Code:

- `apps/api/src/modules/ai/search-orchestrator.ts#L114-L125`
- `apps/api/src/modules/ai/search-orchestrator.ts#L128-L182`
- `apps/api/src/modules/ai/search-orchestrator.ts#L208-L260`
- `apps/api/src/modules/ai/local-docs.ts#L308-L413`
- `apps/api/src/modules/github-kb/service.ts#L430-L528`
- `apps/api/src/modules/github-kb/service.ts#L1593-L1671`

Details:

- `search-orchestrator` filters docs visibility partly by path roots such as `docs/`, `open-docs/`, `deploy-docs/`.
- `search-orchestrator.scoreReferenceQueryMatch()` gives meaningful weight to path token matches.
- `search-orchestrator.scoreDocKindMatch()` still maps `openapi/api`, `product_guide`, `permissions`, and `syntax_reference` using path/title heuristics.
- `local-docs.scoreEntry()` boosts by path fragments and by file-specific patterns such as `03-get-a-issue-details` and `get-a-list-of-issue-status`.
- `github-kb.service` infers `product_area`, `deployment_model`, and `evidence_kind` partly from path.
- `github-kb.service` reranks by path regex for API, deploy-docs troubleshooting, integrations, and even specific filenames like `create-a-new-issue.api.mdx`.

Impact:

- Even if support-agent becomes cleaner, retrieval still remains path-biased.
- The system is not actually selecting evidence because it semantically matches the case; it is often selecting because file location or filename looks likely.
- This is exactly the class of implementation that causes fragile fixes and random regressions when questions are phrased differently.

Assessment:

- The fix must not be isolated to `support-agent.ts`.
- Shared retrieval and rerank layers need cleanup.

### P0. Non-API questions have no strict evidence eligibility gate

Code:

- `apps/api/src/modules/ai/support-agent.ts#L882-L960`

Details:

- `buildEvidencePolicy()` only returns a strict policy for `api_*` question types.
- For non-API routes it returns `null`.
- `isReferenceEligibleForCaseFrame()` therefore becomes a no-op for behavior/capability/deployment questions.

Impact:

- Non-API questions admit broad noisy evidence pools.
- Deployment and capability questions rely on late rerank rather than early candidate rejection.
- This is why tangential docs can survive long enough to become primary evidence or to starve citation closure.

Assessment:

- This is the main reason deployment/behavior/capability scenarios are much more fragile.

### P1. Query expansion is still lexical and easily pollutes retrieval

Code:

- `apps/api/src/modules/github-kb/service.ts#L691-L725`
- `apps/api/src/modules/ai/local-docs.ts#L226-L287`
- `apps/api/src/modules/ai/support-agent.ts#L2585-L2622`

Details:

- `github-kb.service.buildQueryVariants()` expands queries using a fixed replacement table.
- `local-docs.buildQueryVariants()` uses another replacement table plus domain-specific token injection.
- `support-agent.buildApiRetrievalBridgeQuery()` constructs API bridge queries from an intent lexicon.

Impact:

- There are now multiple layers expanding or rewriting the user query.
- These expansions are mostly lexical, not evidence- or metadata-driven.
- API composite questions and deployment architecture questions can both get dragged into the wrong term cluster.

Assessment:

- Query construction should come from structured case-frame intent, not stacked lexical substitution tables.

### P1. Verification and citation binding are too late to recover from polluted evidence bundles

Code:

- `apps/api/src/modules/ai/support-agent.ts#L742-L870`
- `apps/api/src/modules/ai/support-agent.ts#L1232-L1288`
- `apps/api/src/modules/ai/support-agent.ts#L3008-L3196`

Details:

- `buildEvidenceBundle()` can only pick primary/supplemental from already-retrieved references.
- `sanitizeVerification()` drops any verified claim that does not link to evidence present in the final evidence bundle.
- `judgeSupportAnswer()`, `bindSupportCitations()`, and display citation curation all operate after retrieval and evidence selection are already done.

Impact:

- Once the candidate set is wrong, late-stage verification can only downgrade or strip claims.
- This leads to the observed pattern: references exist, but `claim_to_citation_map` is empty and the final answer degrades to `handoff`.

Assessment:

- The empty-citation problem is downstream of retrieval quality, not primarily a composer prompt problem.

### P1. Current local worktree has live regressions, including an API regression to handoff

Verified by test run:

- `apps/api/src/modules/ai/support-agent.test.ts#L737-L759`
- `apps/api/src/modules/ai/support-agent.test.ts#L1330-L1358`
- `apps/api/src/modules/ai/support-agent.test.ts#L1427-L1440`

Failures:

1. Fast-path grounded how-to answer no longer skips judge/composer/curator as expected.
2. Stage-budget behavior no longer matches the existing test expectation.
3. API field recovery from project-list evidence degrades to `handoff`.

Impact:

- The worktree is not in a stable state.
- The API field recovery failure is especially important because it confirms that API answer quality is still not reliable.

Assessment:

- Do not treat the current local patch as ready for push.

### P2. Tests are overfitting to path-based success instead of semantic success

Code:

- `apps/api/src/modules/ai/support-agent.test.ts#L1048-L1050`
- `apps/api/src/modules/ai/support-agent.test.ts#L1178-L1186`

Details:

- Some tests assert that the top reference path matches `open-docs/docs/openapi/api/`.
- The new self-hosted deployment test asserts that the top reference path matches `^deploy-docs/`.

Impact:

- Tests reward path-prefix routing instead of metadata-driven correctness.
- This makes it easier to "fix the test" with more hardcoding.

Assessment:

- Rewrite these assertions to target semantic outcomes instead:
  - correct `caseFrame`
  - irrelevant docs not ranked above relevant ones
  - non-empty citations
  - no `handoff` when evidence exists

### P2. Clarification bookkeeping likely consumes a round early

Code:

- `apps/api/src/modules/ai/support-agent.ts#L1390-L1407`
- `apps/api/src/modules/ai/support-agent.ts#L3198-L3204`
- `apps/api/src/modules/ai/support-agent.ts#L3255-L3262`

Details:

- `resolveSupportMode()` compares `currentRound < AI_SEARCH_MAX_CLARIFICATION_ROUNDS`.
- `runSupportSearchAgent()` passes `input.currentRound + 1` into `resolveSupportMode()`.
- Clarification round and handoff bookkeeping also use `input.currentRound + 1`.

Impact:

- This may shorten clarification opportunities by one turn depending on caller behavior.
- It is not the primary answer-quality failure here, but it can make the system escalate to handoff earlier than expected.

## Why The Reported Self-Hosted Failure Happens

The current failure chain is:

1. The raw query is retrieved before the planner output is stabilized.
2. Retrieval and rerank still contain strong lexical/path heuristics.
3. Evidence plan pollution such as `openapi/api` and `syntax_reference` is not prevented early enough.
4. Non-API evidence gating is weak, so irrelevant references survive.
5. The evidence bundle cannot support claim-to-citation closure.
6. The final answer falls back to `handoff`.

This matches the user-observed output exactly.

## Why API Questions Still Fail

API questions are not solved. Current code still fails API scenarios when:

1. First-pass retrieval misses the correct operation before the route/case-frame stabilizes.
2. Lexical expansion or file/path heuristics pull in the wrong nearby operation.
3. Evidence selection does not preserve the correct primary chunk.
4. Verification cannot attach evidence IDs to the recovered claim.

The failing test `runSupportSearchAgent recovers grounded API field claims from project list evidence when specialist claims are empty` is concrete proof that API can still collapse into `handoff` in the current local worktree.

## Recommended Fix Direction

### 1. Move first-pass retrieval after case-frame stabilization

Required change:

- Run `routeSupportQuestion()`, `planSupportEvidence()`, `planSupportCase()`, `mergeRouteAndEvidencePlan()`, and `stabilizeSupportRouteAndCaseFrame()` first.
- Only then build first-pass retrieval queries.

Goal:

- First-pass retrieval must already know whether the question is API, deployment, syntax, behavior, permissions, or troubleshooting.

### 2. Replace path-driven gating with metadata-driven gating

Required change:

- Build evidence eligibility rules for non-API question types using:
  - `supportMetadata.product_area`
  - `supportMetadata.deployment_model`
  - `supportMetadata.evidence_kind`
  - `supportMetadata.permissions`
  - `supportMetadata.applies_to`

Do not use:

- directory prefix tests such as `deploy-docs/`
- file prefix or file name tests such as `03-get-a-issue-details`
- question-specific regex trees as the primary decision layer

### 3. Reduce stacked lexical query rewriting

Required change:

- Generate retrieval queries from structured case-frame intent instead of multiple replacement tables.
- Keep lexical expansion only as a limited fallback.

### 4. Clean up shared retrieval scoring

Required change:

- Remove or sharply reduce path/file-based boosts from:
  - `search-orchestrator`
  - `local-docs`
  - `github-kb.service`

- Prefer boosts from metadata and semantically extracted content.

### 5. Make evidence closure the success criterion

Required change:

- For deployment/capability/API questions, a successful answer should require:
  - primary evidence aligned with case-frame intent
  - at least one claim with attached citation IDs

If evidence exists but no claim can be closed, treat that as a retrieval/evidence-selection defect, not as a writer-only problem.

### 6. Rewrite regression tests around semantics, not paths

Required change:

- Replace path assertions with assertions on:
  - `caseFrame.deployment_model`
  - `caseFrame.product_area`
  - `required_doc_kinds`
  - top-ranked irrelevant docs excluded from primary position
  - `citations.length > 0`
  - `support_answer.mode !== "handoff"` when supported evidence exists

## Minimum Acceptance Criteria

For the reported self-hosted deployment question:

1. `deployment_model` must not remain `shared`.
2. `product_area` must not remain `general`.
3. `Azure AD & ONES.com` must not outrank deployment evidence.
4. `citations.length` must be greater than `0`.
5. Final answer must not default to `handoff` if the deployment docs support a narrow best-effort answer.

For API quality:

1. The project-list/project-id recovery test must stop falling back to `handoff`.
2. Composite API questions must keep the intended operation above nearby variants.
3. API answers must still emit citation-backed claims after retrieval/rerank changes.

For implementation discipline:

1. No new path-prefix routing in support answer logic.
2. No query-specific hardcoded fixes for the reported user question.
3. Shared retrieval layers must be updated together with support-agent changes.

## Final Assessment

The current answer-quality issue is fundamentally a retrieval and evidence-quality problem, not a wording problem.

The current local patch direction improves one reported deployment query by layering more regex and path heuristics, but it does not solve the structural issue and it introduces or coexists with regressions, including an API handoff regression.

The correct fix direction is:

- stabilize before first retrieval
- gate by metadata, not by path
- reduce lexical hardcoding
- require citation-backed closure as the success condition
