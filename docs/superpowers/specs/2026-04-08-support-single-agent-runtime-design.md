# Support Single-Agent Runtime Design

Date: 2026-04-08

Status: proposed, revised after live cloud probe

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

### 4.3 Current live cloud OpenClaw reality

Live cloud probing against `wss://47.250.122.37/` confirmed:

1. the gateway does not expose RPC method `kb.search`
2. current `WsOpenClawAdapter.searchKnowledge()` therefore falls back to `searchViaChat(...)`
3. `searchViaChat(...)` only returns weak retrieval fields (`id`, `title`, `snippet`, `score`, `sourceUrl`)
4. existing live support/search agents can be listed and pinged, but current multi-agent topology remains active
5. tested candidate agents are not currently safe drop-in replacements for end-to-end support answering

This means the old assumption "Phase 1 should harden `kb.search` transport first" is no longer accurate for the live production source of truth.

### 4.4 Current OpenClaw contract gaps

The real live contract gap is not just missing typed fields on `OpenClawSearchOutput`.

The live production gap is:

1. no production-safe single-agent support contract exists yet
2. live chat-based retrieval output does not carry backend-verifiable publication-bound evidence identity
3. the backend currently has no dedicated reconciliation layer that maps agent-returned references back onto the active published KB snapshot

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

Retrieval must remain OpenClaw-driven, but the live gateway cannot currently be treated as a typed KB RPC.

The production-safe model is therefore:

1. the single support agent performs retrieval and answering inside one OpenClaw run
2. the agent must return structured references for the evidence it used
3. the backend reconciles those references against the active published KB snapshot before delivery

The agent-returned reference contract must include enough locator data for reconciliation:

- `reference_id`
- `title`
- `snippet`
- `sourceUrl`
- `path`
- `headingPath`
- `repoSourceUrl` when available

The backend then resolves each returned reference onto the published snapshot and maps it to canonical runtime evidence ids.

### 6.3 Single-agent answer model

The backend should add one single-agent method boundary for support answers.

Recommended adapter method:

- `runSupportMainAgent(...)`

Its responsibilities:

1. accept the user question and recent conversation
2. perform scoped retrieval on the OpenClaw side
3. produce the final structured support answer
4. return structured references plus claim-level `reference_id` bindings
5. return structured diagnostics such as retrieval queries used and clarification reason when needed

The backend must still validate:

1. returned `reference_id`s are present in the returned references
2. returned references reconcile to the active runtime serving scope
3. reconciled references map to canonical runtime evidence ids
4. unsupported / unreconciled factual claims are downgraded before user delivery

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

### Phase 1: Single-Agent Contract And Published-Snapshot Validation

Tasks:

1. add the new `runSupportMainAgent(...)` adapter contract
2. define the single-agent JSON schema for answer draft, claims, references, and retrieval queries
3. add backend reference reconciliation against the active published KB snapshot
4. add focused tests proving unresolved references cannot leak into verified delivery

Gate:

- one agent run can produce a draft answer, and every delivered factual claim must reconcile to published evidence

### Phase 2: Single-Agent Runtime Implementation

Tasks:

1. add the single-agent feature flag
2. implement the new adapter method for the single support agent
3. create a simplified `runSupportSearchAgent()` path for single-agent mode
4. bypass retired multi-agent stages when single-agent mode is enabled
5. keep deterministic backend validation gates for citations and unsupported claims

Gate:

- the request path must no longer depend on planner/router/specialist drift

### Phase 3: Runtime Stability And Timeout Closure

Tasks:

1. re-check the async search-job timeout behavior under the simplified runtime
2. ensure stage progress, terminal state, and front-end wait window remain coherent
3. confirm the simplified runtime does not reintroduce infinite wait / request flood symptoms

Gate:

- the support request must enter a terminal state inside the expected interactive or async budget

### Phase 4: Live OpenClaw Alignment

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

### Phase 5: Full Verification And Production Readiness Review

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

1. OpenClaw adapter gains a dedicated single-agent support contract
2. support runtime diagnostics gain single-agent-specific fields
3. feature-flag-driven runtime selection is added
4. backend reference reconciliation maps agent-returned references onto published evidence ids

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

1. contract tests for single-agent request/response parsing
2. reference-reconciliation tests against published-snapshot candidates
3. runtime tests proving single-agent mode bypasses retired multi-agent stages
4. regression tests for business-critical queries:
   - API scope question
   - ONESQL capability question
   - GitHub callback troubleshooting
   - deployment requirements question
5. build verification
6. preview-equivalent replay
7. live OpenClaw trace review

## 11. Main Failure Risks

### Risk 1: live OpenClaw agent still cannot produce stable structured references

Mitigation:

- probe live capability first
- keep flag-gated rollout
- require backend reconciliation before delivery
- do not remove compatibility path until live agent behavior is verified

### Risk 2: backend reconciliation is too weak and accepts the wrong published chunk

Mitigation:

- match by published snapshot locator data
- reject ambiguous matches
- downgrade claims when reconciliation is not unique

### Risk 3: runtime still falls back to old multi-agent path in preview

Mitigation:

- emit explicit diagnostics for `runtime_mode=single_agent`
- inspect live cloud traces before any production claim

### Risk 4: simplified runtime still times out or leaves async jobs hanging

Mitigation:

- verify job terminal-state timing explicitly
- check preview request/polling behavior alongside OpenClaw traces

## 12. Production Standard

This work is only production-ready when all of the following are true:

1. single-agent mode is actually active in preview-equivalent runtime
2. business regression questions return grounded answers with correct citations
3. OpenClaw trace review confirms the live cloud agent follows the new contract
4. build, focused tests, and runtime replays are green
5. no unresolved blocker remains on KB publication safety or citation integrity
