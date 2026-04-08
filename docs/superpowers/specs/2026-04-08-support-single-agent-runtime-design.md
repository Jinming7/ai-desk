# Support Single-Agent Runtime Design

Date: 2026-04-08

Status: proposed

## 1. Goal

Rebuild the customer-facing support runtime so one OpenClaw support agent owns the answer path, retrieval remains OpenClaw-driven instead of local heuristic routing, and the final answer stays grounded to the currently published KB snapshot for the active runtime knowledge space.

This design is explicitly intended to replace the current multi-agent support hot path for the user-facing support flow.

## 2. Why This Change Is Required

The current support runtime still fails the business requirement even after earlier hardening work.

Confirmed failure classes:

1. correct retrieval can still be degraded by downstream planner/router/specialist/verification drift
2. the request hot path still burns too much interactive budget before useful evidence is bound
3. the current chain exposes too many cross-agent semantic boundaries, so a good early retrieval result can still become a wrong final answer

The user requirement is now explicit:

- business answer quality is the only success metric
- agent retrieval must remain the main paradigm
- a single OpenClaw agent is preferred if that reduces answer drift
- local heuristic routing must not become the primary product behavior

## 3. Non-Negotiable Constraints

This design must obey all repository-level constraints in `AGENTS.md` and the canonical rebuild contract in `docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`.

Critical constraints:

1. support remains AI-driven, not rule-tree-driven
2. runtime retrieval must remain publication-bound and knowledge-space-bound
3. unfinished or unpublished KB artifacts must never leak into customer-facing retrieval
4. the answer path must preserve multi-turn conversation state
5. customer-facing answers must follow `docs/agents/support-answer-composer.md`
6. no narrow query-specific regex patches as the main fix

## 4. Current Flow And Confirmed Gaps

### 4.1 Current retrieval path

Current `SearchOrchestrator.collectEvidence()` behavior:

1. normalize query
2. retrieve knowledge from publication-bound KB (`githubKbService.retrieveKnowledgeWithRetry`)
3. rerank and merge references
4. only fall back to `adapter.searchKnowledge()` when KB-side retrieval is unavailable

This means the current main retrieval path is not OpenClaw-agent-owned end to end.

### 4.2 Current support orchestration path

Current `runSupportSearchAgent()` behavior still includes:

1. unified planner or route + evidence-plan + case-plan
2. evidence selection
3. specialist drafting
4. verification
5. answer composition

Even after some deterministic recovery hardening, the request path still crosses multiple semantic stages and can drift after retrieval.

### 4.3 Current OpenClaw contract gaps

Current `OpenClawSearchInput` only carries:

- `query`
- `topK`
- `index`
- `attachments`

Current `OpenClawSearchOutput` only carries:

- `id`
- `title`
- `snippet`
- `score`
- `sourceUrl`

This is not enough for production-grade single-agent grounding because it lacks:

1. explicit runtime serving scope (`knowledge_space`, publication/build boundary)
2. chunk-level evidence identity
3. path / heading / metadata needed for answer-quality validation

## 5. Options Evaluated

### Option A: Keep multi-agent chain and keep patching drift points

Rejected.

Reason:

- this is the exact failure pattern that already consumed too much time
- every additional patch still preserves the same drift-prone topology

### Option B: Remove OpenClaw retrieval and fall back to local deterministic retrieval + one answer agent

Rejected as the primary design.

Reason:

- this violates the user's explicit requirement that retrieval should remain agent/OpenClaw-driven
- it would move the system toward a local heuristic stack again

### Option C: Single OpenClaw support agent + OpenClaw retrieval contract + service-side grounding gates

Recommended.

Reason:

1. eliminates most cross-agent drift
2. preserves AI-driven runtime behavior
3. keeps retrieval on the OpenClaw side instead of local support-specific heuristics
4. still allows the backend to enforce publication-bound grounding and citation integrity

## 6. Recommended Architecture

### 6.1 Runtime ownership

The user-facing support path should be reduced to one OpenClaw support agent:

- logical agent id: `support-main`

That agent becomes the only customer-facing support reasoning agent in the runtime path.

Retired from the request hot path:

- `support-router`
- `support-evidence-planner`
- `support-planner`
- `support-api-specialist`
- `support-howto-specialist`
- `support-behavior-specialist`
- `support-troubleshooting-specialist`
- `support-evidence-judge`
- `support-answer-composer`

These old agent ids may remain temporarily for compatibility during rollout, but the request path should not depend on them.

### 6.2 Retrieval model

Retrieval must remain OpenClaw-driven.

Required production contract:

`OpenClawSearchInput` must be extended with:

- `knowledgeSpace`
- `repoId`
- `branch`
- `publicationId` or `buildVersion`
- `requiredDocKinds`
- `conversationHistory` (optional)

`OpenClawSearchOutput.hits[]` must be extended with:

- `evidenceId`
- `documentId`
- `path`
- `headingPath`
- `supportMetadata`
- `repo`
- `branch`
- `commitSha`
- `repoSourceUrl`

This allows the backend to validate that the answer is still bound to the active published snapshot.

### 6.3 Single-agent answer model

The backend should add one single-agent method boundary for support answers.

Recommended adapter method:

- `runSupportMainAgent(...)`

Its responsibilities:

1. accept the user question and recent conversation
2. perform scoped retrieval on the OpenClaw side
3. produce the final structured support answer
4. return the exact references/citation ids it used
5. return structured diagnostics such as retrieval queries used and clarification reason when needed

The backend must still validate:

1. returned citation ids are present in the returned references
2. returned references belong to the active runtime serving scope
3. unsupported / uncited factual claims are downgraded before user delivery

### 6.4 Backward-compatible rollout model

Rollout should be gated by a feature flag:

- `FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME`

Behavior:

1. flag off: current runtime remains available as fallback
2. flag on: user-facing support flow takes the single-agent path

The compatibility period is only for rollout safety.
The production target remains the single-agent path.

## 7. Detailed Phase Map

### Phase 0: Design Lock And Capability Probe

Tasks:

1. freeze the design and execution plan in repository docs
2. bootstrap isolated worktree dependencies
3. probe live OpenClaw topology and confirm current support agent/tool capabilities
4. confirm whether live agent sessions can perform retrieval with citation-safe outputs

Gate:

- no implementation starts until the contract gap list is explicit and testable

### Phase 1: Retrieval And Citation Contract Hardening

Tasks:

1. extend `OpenClawSearchInput` / `OpenClawSearchOutput`
2. extend WS adapter transport and parsing
3. preserve backward compatibility for older gateway payloads
4. add focused contract tests proving evidence identity survives transport

Gate:

- a retrieval hit must carry enough data for chunk-level grounding and publication-bound validation

### Phase 2: Single-Agent Runtime Implementation

Tasks:

1. add the single-agent feature flag
2. implement the new adapter method for the single support agent
3. create a simplified `runSupportSearchAgent()` path for single-agent mode
4. bypass retired multi-agent stages when single-agent mode is enabled
5. keep deterministic backend validation gates for citations and unsupported claims

Gate:

- the request path must no longer depend on planner/router/specialist drift

### Phase 3: Live OpenClaw Alignment

Tasks:

1. update live `agent.md` / agent instructions for the selected support-main agent
2. encode hard rules:
   - retrieve before answering
   - use only returned evidence ids for citations
   - do not state unsupported capability claims
   - ask only minimum blocking clarification
3. verify live topology resolution from the app runtime

Gate:

- the live cloud agent behavior matches the new backend contract

### Phase 4: Full Verification And Production Readiness Review

Tasks:

1. run build
2. run focused unit/integration regressions
3. replay real business questions in preview-equivalent runtime
4. inspect OpenClaw traces and output quality
5. review whether support can honestly be called production-ready

Gate:

- no `可投产` claim without fresh verification evidence

## 8. Data Model Impact

No KB publication model changes are required for this design.

Expected application-side changes:

1. OpenClaw transport types grow richer retrieval fields
2. support runtime diagnostics gain single-agent-specific fields
3. feature-flag-driven runtime selection is added

This design must not weaken publication-based KB serving semantics.

## 9. State Transitions And Retry Model

Interactive mode:

1. resolve runtime scope
2. call single-agent support path
3. validate returned citations / references
4. materialize support answer

Async mode:

1. enqueue job
2. run the same single-agent support path under durable job lease
3. persist stage progress
4. persist final answer or retryable failure

Idempotency rules:

1. OpenClaw calls remain keyed by request/session-derived idempotency keys
2. async jobs remain lease-protected and resumable
3. validation failure must degrade the answer, not publish unverifiable claims

## 10. Verification Plan

Required verification layers:

1. contract tests for retrieval request/response transport
2. runtime tests proving single-agent mode bypasses retired multi-agent stages
3. regression tests for business-critical queries:
   - API scope question
   - ONESQL capability question
   - GitHub callback troubleshooting
   - deployment requirements question
4. build verification
5. preview-equivalent replay
6. live OpenClaw trace review

## 11. Main Failure Risks

### Risk 1: live OpenClaw agent lacks required retrieval tool behavior

Mitigation:

- probe live capability first
- keep flag-gated rollout
- do not remove compatibility path until live agent behavior is verified

### Risk 2: retrieval still leaks across publication boundaries

Mitigation:

- require explicit scope fields in retrieval contract
- validate references against the active runtime scope

### Risk 3: single-agent output becomes harder to audit

Mitigation:

- require structured JSON output
- require returned references plus exact citation ids
- keep backend validation and unsupported-claim downgrade

### Risk 4: rollout silently continues using old multi-agent path

Mitigation:

- emit explicit diagnostics for `runtime_mode=single_agent`
- verify topology and stage trace in preview before any production claim

## 12. Production Standard

This work is only production-ready when all of the following are true:

1. single-agent mode is actually active in preview-equivalent runtime
2. business regression questions return grounded answers with correct citations
3. OpenClaw trace review confirms the live cloud agent follows the new contract
4. build, focused tests, and runtime replays are green
5. no unresolved blocker remains on KB publication safety or citation integrity
