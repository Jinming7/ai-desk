# Support Runtime Productionization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the support-agent runtime so preview and production can serve grounded, reliable answers from published KB snapshots without request-time budget collapse, while preserving publication-based KB truth and rollout safety.

**Architecture:** Replace the current multi-stage planner hot path with a single schema-first `SupportExecutionPlan`, move heavy support execution to a durable async job runtime, and use SSE as the preferred delivery channel with polling fallback. Runtime retrieval remains publication-bound, hybrid retrieval becomes a real rollout baseline, and grounded degraded answers replace unhelpful handoff when coherent evidence exists.

**Tech Stack:** Node.js 20.20.1, Express API, OpenClaw WS adapter, Vercel Node Functions, PostgreSQL, tsx/node:test, KB publication runtime.

---

## Phase Overview

### Phase 0: Root Cause Lock

**Status:** Completed

**Confirmed facts:**
- Preview KB has a published snapshot and raw KB retrieval can reach the correct deployment requirements document.
- Current preview runtime does not enable `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL`.
- `route` can succeed with correct branch-scoped preview env, but `evidence-plan` and `case-plan` can time out in the request hot path.
- When `case-plan` falls back, `fallbackCaseFrame(query)` overwrites the successful route semantics.
- Retrieval then runs with degraded queries and consumes the remaining request budget.
- Downstream `evidence_selection`, `specialist`, `generic_writer`, `verification`, and `answer_composition` are skipped by budget gates.
- Current `overallTimeoutMs=22000` is a code-level serverless budget, not a Vercel platform hard limit.

**Gate to Phase 1:** Root cause must be reproducible and explained without guesswork. Satisfied.

### Phase 1: Unified Schema-First Planner

**Outcome target:** Replace `route + evidence-plan + case-plan` hot-path composition with one canonical `SupportExecutionPlan`.

**Success criteria:**
- `SupportExecutionPlan` is the only planner output consumed by support orchestration.
- Successful route semantics are never overwritten by fallback case-frame synthesis.
- Planner failure degrades through a schema-first synthesizer, not through raw query heuristics.
- Retrieval queries originate from the unified plan.

**Primary files:**
- Create: `apps/api/src/modules/ai/support-execution-plan.ts`
- Create: `apps/api/src/modules/ai/support-execution-plan.test.ts`
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Modify: `apps/api/src/infrastructure/openclaw/types.ts`
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`

**Files to avoid in Phase 1 due current parallel dirty state:**
- `apps/api/src/modules/ai/search-orchestrator.ts`
- `apps/api/src/modules/ai/search-orchestrator.test.ts`
- `apps/api/src/modules/ai/support-agent.test.ts`

**`SupportExecutionPlan` schema (target):**
- `route`
- `caseFrame`
- `evidencePlan`
- `retrievalPlan`
- `degradedPolicy`
- `budgetHints`
- `plannerDiagnostics`

**Key invariants:**
- Publication-scoped KB truth remains unchanged.
- Planner output must be schema-first and serializable.
- Fallback may fill missing fields, but may not downgrade already successful route semantics.
- Planner diagnostics must distinguish `completed`, `timeout`, `parse_failure`, `transport_failure`, and `synthesized`.

**Phase 1 tasks:**
- [ ] Define `SupportExecutionPlan` TypeScript schema and planner diagnostics types.
- [ ] Write failing tests for:
  - successful route preserved when case/evidence planning fail
  - synthesized case frame inherits route semantics instead of reverting to `general/shared/troubleshooting/unspecified`
  - retrieval query plan comes from unified plan rather than `fallbackCaseFrame(query)`
- [ ] Implement unified planner resolution in a new isolated module.
- [ ] Update `support-agent.ts` to consume unified planner output.
- [ ] Run focused tests and local preview-env reproduction.
- [ ] Commit milestone `M1` after tests pass.

**Gate to Phase 2:**
- Unified planner tests green.
- Reproduced Linux distribution query no longer degrades into generic planner state.
- No shared dirty file conflicts introduced.

### Phase 2: Durable Async Support Runtime

**Outcome target:** Move heavy support execution out of the request hot path into a durable job runtime.

**Success criteria:**
- Request submission creates a support-search job and returns a job identifier.
- Worker executes planner, retrieval, evidence selection, drafting, verification, and answer composition durably.
- Support execution no longer depends on a single Vercel request lifetime for correctness.
- Failures are resumable and observable.

**Primary files:**
- Create: `apps/api/src/modules/ai/support-search-jobs.ts`
- Create: `apps/api/src/modules/ai/support-search-jobs.test.ts`
- Create: `apps/api/src/modules/ai/support-search-worker.ts`
- Create: `apps/api/src/modules/ai/support-search-worker.test.ts`
- Modify: `apps/api/src/modules/ai/service.ts`
- Modify: `apps/api/src/app.ts`
- Modify: repository/db files as needed for job persistence

**State machine target:**
- `queued`
- `running`
- `partial_result_ready`
- `completed`
- `failed_retryable`
- `failed_terminal`
- `cancelled`

**Key invariants:**
- Job execution is idempotent by logical request key.
- Final answer materialization is persisted separately from in-flight stage state.
- A partial stage failure cannot silently erase prior successful stage outputs.
- Publication-based KB snapshot truth remains read-only at runtime.

**Phase 2 tasks:**
- [ ] Write failing tests for job lifecycle, retry/resume, and partial result publication.
- [ ] Define persistence model and repository APIs.
- [ ] Implement submit/status/cancel service APIs.
- [ ] Implement worker loop and stage persistence.
- [ ] Add structured failure reasons for budget exhaustion, planner timeout, retrieval timeout, and verification timeout.
- [ ] Run job lifecycle tests and focused runtime smoke tests.
- [ ] Commit milestone `M2`.

**Gate to Phase 3:**
- A heavy support request can complete through the async runtime without request-bound timeout collapse.
- Retry/resume behavior is deterministic and tested.

### Phase 3: Delivery Layer and Budget Redesign

**Outcome target:** Make async runtime user-visible in a production-grade way and remove hardcoded request-budget correctness coupling.

**Preferred delivery design:**
- Canonical execution: async job
- Preferred delivery channel: SSE
- Compatibility fallback: polling

**Why this choice:**
- SSE alone does not solve durability or retry semantics.
- Polling alone is operationally acceptable but weak for UX and stage visibility.
- Async job + SSE solves correctness and usability together.

**Success criteria:**
- The portal can subscribe to job progress over SSE.
- Polling can retrieve equivalent state when SSE is unavailable.
- Request hot path budget becomes an admission policy, not the system correctness boundary.
- `overallTimeoutMs=22000` is removed as a hardcoded runtime invariant.

**Primary files:**
- Create: `apps/api/src/modules/ai/support-search-stream.ts`
- Create: `apps/api/src/modules/ai/support-search-stream.test.ts`
- Modify: `apps/api/src/modules/ai/agent-router.ts`
- Modify: `apps/api/src/app.ts`

**Phase 3 tasks:**
- [ ] Write failing tests for SSE event ordering and polling fallback parity.
- [ ] Replace hardcoded serverless `overallTimeoutMs=22000` with configuration + admission policy.
- [ ] Implement SSE endpoint for job progress and final answer delivery.
- [ ] Implement polling endpoint using the same job truth.
- [ ] Add explicit reason codes for skipped/deferred stages.
- [ ] Run SSE/polling tests and preview smoke verification.
- [ ] Commit milestone `M3`.

**Gate to Phase 4:**
- User-facing answer availability no longer depends on finishing the whole chain within a single request.
- Stage skipping becomes explicit and observable.

### Phase 4: Hybrid Retrieval Baseline and Runtime Flag Semantics

**Outcome target:** Align preview runtime with the intended retrieval architecture and remove false release semantics.

**Success criteria:**
- Preview branch environment explicitly enables hybrid retrieval.
- Runtime diagnostics confirm hybrid retrieval is actually being used.
- `FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING` is either wired into real behavior or explicitly downgraded from rollout semantics.

**Primary files:**
- Modify: `apps/api/src/modules/ai/search-orchestrator.ts` (serialized integration required)
- Modify: `apps/api/src/modules/ai/release/service.ts`
- Modify: release/runtime docs as needed

**Phase 4 tasks:**
- [ ] Write/extend tests for hybrid retrieval runtime selection and diagnostics.
- [ ] Enable preview branch baseline for `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL`.
- [ ] Clean up flag semantics for runtime tightening.
- [ ] Re-run preview runtime inspection and retrieval diagnostics.
- [ ] Commit milestone `M4`.

**Gate to Phase 5:**
- Preview runtime genuinely uses hybrid retrieval.
- Release status and runtime behavior match.

### Phase 5: Grounded Degraded Answer Contract

**Outcome target:** If coherent grounded evidence exists, the support agent must still produce a conservative, useful answer instead of jumping straight to handoff.

**Success criteria:**
- Handoff only occurs when evidence is absent, contradictory, or truly insufficient.
- Grounded degraded answers remain citation-bound.
- This contract is general, not query-specific.

**Primary files:**
- Create: `apps/api/src/modules/ai/grounded-degraded-answer.ts`
- Create: `apps/api/src/modules/ai/grounded-degraded-answer.test.ts`
- Modify: `apps/api/src/modules/ai/support-agent.ts`

**Phase 5 tasks:**
- [ ] Write failing tests for grounded degraded answers after downstream stage failure.
- [ ] Implement minimal grounded answer generation from coherent primary evidence.
- [ ] Tighten handoff conditions.
- [ ] Run focused fallback-contract tests and preview live validation.
- [ ] Commit milestone `M5`.

**Gate to Phase 6:**
- Grounded evidence no longer collapses to handoff by default.

### Phase 6: Preview End-to-End Gate

**Outcome target:** Preview behaves like a real support agent, not a diagnostic stub.

**Scenario matrix:**
- Linux distribution support / deployment requirements
- deployment how-to
- API lookup
- troubleshooting
- clarification-required
- no-evidence path

**Success criteria:**
- Preview answers key queries with grounded support answers.
- Citations are coherent and publication-bound.
- Runtime diagnostics no longer show generic planner collapse or silent downstream skip chains.

**Phase 6 tasks:**
- [ ] Run preview E2E scenario matrix.
- [ ] Validate status endpoints, job endpoints, and runtime diagnostics.
- [ ] Commit milestone `M6`.

**Gate to Phase 7:**
- Preview reaches non-production rollout readiness.

### Phase 7: Docs, Runbooks, and Production Gate

**Outcome target:** Documentation and operations semantics match the final runtime.

**Success criteria:**
- `schema-first` is documented as a hard constraint.
- Async runtime, SSE delivery, polling fallback, and hybrid baseline are documented.
- Rollout/rollback/operator semantics are aligned.
- Production gate can be assessed honestly.

**Primary files:**
- `docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
- `docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
- `docs/26_AI_Support_Agent_Rebuild_Part_06_Evaluation_Acceptance_And_Regression.md`
- `docs/28_AI_Support_Agent_Rebuild_Part_08_Rollout_Rollback_And_Operations.md`
- `docs/29_AI_Support_Agent_Rollout_Operator_Runbook.md`
- plan documents as needed

**Phase 7 tasks:**
- [ ] Update docs to reflect final runtime architecture and hard constraints.
- [ ] Reconcile release flag semantics and rollout guidance.
- [ ] Run final acceptance checklist.
- [ ] Commit milestone `M7`.

**Final production gate:**
- Preview gate green
- Hybrid retrieval baseline aligned
- Async runtime durable
- Grounded degraded answers available
- Docs/runbooks aligned
- KB publication truth preserved

## ETA Model

**Quality-first estimate:**
- Phase 1 design lock + implementation: 4.5 to 7 hours
- Phase 2 durable async runtime: 5 to 7 hours
- Phase 3 delivery/budget redesign: 2 to 3 hours
- Phase 4 hybrid baseline: 1.5 to 2.5 hours
- Phase 5 degraded-answer contract: 1.5 to 2.5 hours
- Phase 6/7 validation, docs, runbooks: 2 to 3 hours

**Best case:** 16.5 hours  
**Practical range:** 18 to 25 hours

This is the honest estimate for a production-grade implementation without trial-and-error.

## Phase 1 Immediate Risk Notes

- Parallel dirty files currently exist in:
  - `apps/api/src/modules/ai/search-orchestrator.ts`
  - `apps/api/src/modules/ai/search-orchestrator.test.ts`
  - `apps/api/src/modules/ai/support-agent.test.ts`
- Phase 1 must avoid those files except where serialized integration becomes unavoidable.
- There is a long-running external OpenClaw governance process; no destructive remote ops should be assumed safe during this plan.

## Immediate Next Action

- [ ] Create implementation-grade `SupportExecutionPlan` schema and failing tests for route-preserving unified planner behavior before any production code changes.
