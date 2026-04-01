# AI Support Root Cause And Remediation Plan

Date: 2026-03-25

Scope: convert the latest root-cause review into an actionable remediation plan for the `support` pipeline, with explicit separation between `knowledge availability`, `chunk/index quality`, and `orchestration/routing` failures.

## Executive Summary

The current answer-quality problem is not a single pipeline bug.

There are at least three different failure classes:

1. `open-docs` is missing from the live KB index, so many API / OpenAPI / ONESQL questions are unanswerable regardless of routing quality.
2. Some `docs/` articles are indexed as documents, but the live `kb_chunks` do not expose the answer-bearing passage strongly enough for retrieval and evidence selection.
3. The local support orchestration still contains route-stabilization logic that can force integration troubleshooting questions back into `api_scope_auth`, which further degrades evidence selection.

This means the fix order must change:

1. Restore live knowledge completeness.
2. Repair chunk visibility and retrieval inputs for answer-bearing passages.
3. Tighten routing and evidence-policy behavior only after the knowledge layer is healthy.

## Confirmed Findings

### 1. Live KB is incomplete for `open-docs`

Confirmed from live database:

- Active repo registration: `BangWork/docs-com:master`
- Active `kb_documents` buckets:
  - `docs/`: present
  - `deploy-docs/`: present
  - `open-docs/`: `0`
- `ONESQL` related active documents: `0`

Confirmed from local mirror:

- `/tmp/docs-com/open-docs/docs/openapi/api/onesql.info.mdx`
- `/tmp/docs-com/open-docs/docs/openapi/api/execute-onesql.api.mdx`
- `/tmp/docs-com/open-docs/docs/openapi/auth/scope.md`

Impact:

- `What scope is required to create an issue comment via OpenAPI?` cannot be solved reliably from the live KB.
- `Does ONESQL support ORDER BY and GROUP BY?` cannot be solved reliably from the live KB.
- Any attempt to fix these cases only in `support-agent.ts` would be treating a knowledge-ingestion failure as an orchestration failure.

### 2. GitHub callback troubleshooting knowledge exists, but evidence exposure is weak

Confirmed from live KB:

- `docs/ones-devops/code-integration/github-and-public-gitlab.mdx`
- `docs/admin/set-up-your-team/advanced-settings/notes-for-modifying-the-baseurl.mdx`

Confirmed from local mirror source content:

- The GitHub integration doc contains callback-troubleshooting signals such as `Redirect URI`, callback address, and `baseURL`.

Confirmed from live chunk inspection:

- The GitHub integration document has chunks.
- The answer-bearing callback passage is not visible as a focused retrieval-ready chunk snippet.
- Querying live chunks directly by `page not found`, `redirect uri`, `callback`, or `baseURL` did not yield the expected focused troubleshooting chunk.

Impact:

- Retrieval may hit the correct document title while still failing to supply the answer-bearing passage to selector/judge/binder.
- Evidence selection then receives a weak snippet and cannot form a grounded claim.

### 3. Local route stabilization still misclassifies integration troubleshooting

Confirmed from live run diagnostics for:

`GitHub 集成授权后回调页面显示 page not found，怎么排查？`

Observed:

- `route.question_type = api_scope_auth`
- `caseFrame.product_area = integration`
- `caseFrame.action_type = troubleshooting`
- `required_doc_kinds = [openapi/api, permissions]`
- `answer_contract = "Give the exact API answer first."`

The final answer contract matches the local forced-API rewrite in:

- `apps/api/src/modules/ai/support-agent.ts`

Impact:

- Even when the knowledge exists in `docs/`, the route can still bias the pipeline toward API specialist behavior and wrong doc kinds.

## Root Cause Model

The failures should be modeled as:

### A. Knowledge Availability Failure

Definition:

- The live KB does not contain the required corpus at all.

Current examples:

- OpenAPI / ONESQL / scope questions that depend on `open-docs/`

### B. Knowledge Exposure Failure

Definition:

- The source article exists in the KB, but chunking / chunk content / snippet exposure does not surface the answer-bearing passage.

Current examples:

- GitHub callback troubleshooting in `docs/ones-devops/code-integration/github-and-public-gitlab.mdx`

### C. Orchestration Bias Failure

Definition:

- The support pipeline rewrites or over-constrains the case into the wrong route / doc-kind family.

Current examples:

- Integration OAuth troubleshooting being forced into `api_scope_auth`

## Non-Goals

The following are not acceptable primary fixes:

- Adding more regex branches for specific user questions
- Hardcoding path prefixes for single cases
- Patching answer text after the fact
- Adding one-off rewrites for `ONESQL`, `GitHub callback`, or `scope`
- Treating `retrieval_status=grounded` as sufficient proof that the knowledge layer is healthy

## Remediation Strategy

## Track 1. Restore Live KB Completeness

Priority: `P0`

Objective:

- Ensure the live KB contains the same required corpus family as the local docs mirror, especially `open-docs/`.

Required work:

1. Inspect why active docs-com registration has no `kb_sync_checkpoints`.
2. Verify whether the live sync worker is reading from the local mirror or remote repo for `docs-com`.
3. Verify whether `open-docs/**` is being excluded at registration, file collection, parse, or upsert stage.
4. Rebuild or backfill the live index until `open-docs/` is present in `kb_documents`.
5. Add a health check that fails if any required corpus family count drops to zero:
   - `docs/`
   - `deploy-docs/`
   - `open-docs/`

Files / modules to inspect:

- [service.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts)
- [repository.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts)
- docs-com registration / sync worker runtime

Acceptance criteria:

- `kb_documents where path like 'open-docs/%'` is greater than zero
- `kb_documents` contains ONESQL/OpenAPI documents expected from `/tmp/docs-com`
- `kb_sync_checkpoints` exists and updates for active docs-com registration
- Business eval for API / ONESQL cases no longer fails due to total corpus absence

## Track 2. Fix Chunk Exposure For Answer-Bearing Passages

Priority: `P0`

Objective:

- Ensure retrieval candidates expose the actual answer-bearing passage, not only the article title or the first generic chunk.

Required work:

1. Review markdown section parsing and chunk generation for long `docs/` pages.
2. Confirm whether the answer-bearing paragraph is being merged into a large chunk whose first 220 characters hide the key evidence.
3. Improve chunk construction for support use cases:
   - preserve answer-bearing paragraph locality
   - avoid huge mixed-purpose chunks
   - improve section-level chunk boundaries for operational docs
4. Improve retrieval snippet generation so selector/judge can see the passage that matched the query, not only the chunk prefix.
5. Re-index affected docs after chunking changes.

Files / modules to inspect:

- [markdown.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/markdown.ts)
- [chunker.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/chunker.ts)
- [repository.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/repository.ts)
- [service.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/github-kb/service.ts)

Acceptance criteria:

- The GitHub integration doc produces at least one chunk whose visible snippet contains callback troubleshooting signals such as `Redirect URI`, callback, or `baseURL`
- Retrieval for the GitHub callback case returns a chunk, not only a document title, that directly supports troubleshooting claims
- Evidence selector / judge can produce claim-linked citations for that case

## Track 3. Remove Wrong Forced-API Bias For Integration Troubleshooting

Priority: `P1`

Objective:

- Stop converting integration troubleshooting into API scope/auth unless the user is clearly asking about OpenAPI auth mechanics.

Required work:

1. Review forced-route logic in `stabilizeSupportRouteAndCaseFrame()`.
2. Remove or redesign any route override that infers `api_scope_auth` only from OAuth/auth vocabulary while the case frame says:
   - `product_area=integration`
   - `action_type=troubleshooting`
3. Make route stabilization monotonic:
   - it may refine ambiguity
   - it must not erase a clearer troubleshooting/integration interpretation
4. Ensure `required_doc_kinds` for integration troubleshooting do not default to `openapi/api` and `permissions`.

Files:

- [support-agent.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/support-agent.ts)

Acceptance criteria:

- GitHub callback troubleshooting routes to troubleshooting or how-to, not `api_scope_auth`
- `required_doc_kinds` prefer integration / troubleshooting / configuration evidence instead of OpenAPI-only evidence
- The final answer contract is not API-first for this case

## Track 4. Make Evidence Policy Effective For Non-API Cases

Priority: `P1`

Objective:

- Ensure non-API strict evidence policy is actually applied during evidence bundle construction, not only defined on paper.

Required work:

1. Align `buildEvidencePolicy()` with `buildEvidenceBundle()` and fallback selection.
2. Apply eligibility filtering consistently for non-API strict policies, not only for `api_*`.
3. Avoid letting clearly mismatched deployment/admin/troubleshooting documents remain primary evidence for syntax/capability questions.

Files:

- [support-agent.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/support-agent.ts)

Acceptance criteria:

- When case frame is clearly syntax/capability-oriented, deployment/admin troubleshooting chunks do not survive as primary evidence
- `supported claims > 0` becomes possible only from topically valid evidence, not same-domain noise

## Track 5. Correct Success Semantics And Diagnostics

Priority: `P1`

Objective:

- Stop reporting false success when references exist but no claim/citation closure exists.

Required work:

1. Split `retrieval_status` from `answer_grounding_status`.
2. Keep raw retrieval visibility, but add an explicit grounded-answer diagnostic such as:
   - `evidence_retrieved`
   - `claim_grounded`
   - `citation_bound`
3. Do not allow dashboards or business eval to treat `references.length > 0` as equivalent to a grounded answer.

Files:

- [support-agent.ts](/Users/jeremypeng/Downloads/Workspace/TicketManagement/apps/api/src/modules/ai/support-agent.ts)
- telemetry / business-eval reporting

Acceptance criteria:

- A run with `citations=[]` and `claim_graph=[]` is not reported as success-like grounding
- Diagnostics clearly distinguish:
  - no corpus
  - wrong evidence
  - evidence exists but no claim closure

## Recommended Execution Order

1. `P0` restore `open-docs` indexing in live KB
2. `P0` fix chunk exposure for GitHub integration troubleshooting passages
3. rerun business eval on:
   - GitHub callback troubleshooting
   - issue-comment scope
   - ONESQL ORDER BY / GROUP BY
4. only then change route stabilization and non-API evidence gating
5. finally tighten diagnostics and success semantics

## Validation Matrix

### Case A. Integration Troubleshooting

Question:

`GitHub 集成授权后回调页面显示 page not found，怎么排查？`

Expected:

- route is not `api_scope_auth`
- evidence includes callback / Redirect URI / baseURL troubleshooting passage
- final answer gives direct checks
- citations are non-empty and claim-linked

### Case B. API Scope

Question:

`What scope is required to create an issue comment via OpenAPI?`

Expected:

- live KB contains relevant `open-docs` API / auth docs
- retrieval returns `open-docs` evidence
- final answer either gives exact scope or a narrow documented gap
- citations are non-empty and claim-linked

### Case C. Syntax / Capability

Question:

`Does ONESQL support ORDER BY and GROUP BY?`

Expected:

- live KB contains ONESQL docs
- retrieval returns ONESQL evidence, not deployment/admin docs
- answer gives direct supported conclusion
- citations are non-empty and claim-linked

## Regression Tests To Add

1. KB health test:
   - fail if active docs-com registration has `open-docs` count `0`

2. Chunk exposure test:
   - GitHub integration doc must produce a chunk/snippet containing callback troubleshooting signals

3. Live-corpus smoke test:
   - ONESQL document family present in `kb_documents`
   - issue-comment scope family present in `kb_documents`

4. Orchestration regression:
   - integration OAuth callback troubleshooting must not stabilize to `api_scope_auth`

5. Grounding semantics regression:
   - `references.length > 0` but `claim_graph=[]` and `citations=[]` must not be classified as successful grounding

## Release Gate

Do not treat the fix as complete until all of the following are true:

1. `open-docs` exists in live KB
2. GitHub callback doc exposes the troubleshooting passage at chunk/snippet level
3. the three business cases above all return non-empty claim-linked citations or a justified documented gap
4. diagnostics can distinguish `missing corpus` from `wrong retrieval` from `no citation closure`

## Immediate Recommendation

Do not start by editing answer prompts.

Start with:

1. live KB completeness for `open-docs`
2. chunk/snippet exposure for GitHub callback troubleshooting

Only after those two are fixed should routing and evidence-policy changes be applied.
