# Support Supervisor Domain Runtime Design

Date: 2026-04-09

Status: approved for implementation in this branch

## 1. Goal

Replace the current customer-facing support hot path with a minimal AI runtime that stays usable under preview and production constraints:

1. one supervisor call to understand intent and choose the domain
2. one domain specialist call to answer with evidence
3. local backend finalization for citations, clarification, and answer shaping

The target is not "more clever agent choreography". The target is "works reliably, stays grounded, and does not regress answer quality".

## 2. Business Diagnosis

### 2.1 Why `4af8c82` is the correct baseline

`4af8c82` fixed the preview runtime detection problem without extending the support answer chain itself. It is therefore the last clean baseline before answer-path behavior started changing again.

### 2.2 Why the later commits did not solve the business problem

`dcc668b` tried to stabilize the single-agent path by adding more support-agent logic around routing and retrieval recovery. Business problem: it improved some narrow cases but still kept the answer path coupled to a long support-agent file with multiple recovery branches, more planner metadata normalization, and more runtime-side special handling. That increased operational complexity without reducing the core failure mode: too much reasoning drift and too much latency sensitivity.

`c835440` only repaired preview build breakage on top of that branch. It did not simplify the runtime contract. Business problem: build repair is not the same as request-path simplification, so the preview could still time out or produce unstable behavior even after the branch deployed.

### 2.3 Root cause

The failure is architectural, not just environmental.

The existing options are both wrong for the current business target:

1. the old serial multi-agent chain is too long and too handoff-heavy
2. the later `support-main` single-agent path collapses too much responsibility into one prompt and still needs additional runtime repair logic around it

Both increase the chance that a preview deployment becomes slow, brittle, or semantically unstable.

## 3. Non-Negotiable Constraints

This design preserves repository rules from `AGENTS.md` and the rebuild contract in `docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`.

Required constraints:

1. support remains AI-driven
2. no regex or narrow-query rule trees as the primary fix
3. published KB retrieval remains the grounding source
4. multi-turn conversation history stays role-aware
5. customer-facing output still follows `docs/agents/support-answer-composer.md`
6. the main live path must not require judge/composer/citation-selector stages
7. the main live path must not require multi-pass retrieval refinement

## 4. Target Runtime

### 4.1 Logical runtime

The new primary runtime is:

1. `support-supervisor`
2. backend retrieval
3. exactly one domain specialist
4. local backend finalization

### 4.2 Domain model

The supervisor selects one primary domain:

1. `openapi`
2. `deployment`
3. `docs`

This domain is about knowledge ownership, not answer style.

### 4.3 Why this is better than the current specialist split

The current split is mostly by answer style:

1. API
2. How-to
3. Behavior
4. Troubleshooting

That is useful for rendering, but it is not the right top-level routing boundary for the user's business.

The user's support questions cluster more naturally by domain:

1. OpenAPI and auth questions
2. Deployment and private-environment questions
3. Product/docs capability and behavior questions

The new design routes by domain first, then preserves existing render variants in the final answer shape.

## 5. Mapping To Current Live OpenClaw Reality

The live gateway currently exposes `support-planner`, `support-api-specialist`, `support-howto-specialist`, `support-behavior-specialist`, and `support-troubleshooting-specialist`, but not new cloud agents named `deployment-specialist` or `docs-specialist`.

Therefore this branch implements:

1. new logical supervisor/domain contracts in backend code
2. new domain-specialist prompts in the adapter
3. mapping onto the current live stage bindings where necessary

This means the product behavior changes now, without requiring immediate cloud-topology surgery.

## 6. Detailed Flow

### 6.1 Supervisor

Supervisor responsibilities:

1. preserve user goal and recent conversation context
2. identify `primary_domain`
3. emit one coherent route and case frame
4. produce single-pass retrieval queries
5. keep missing-info requests narrow

Supervisor must not:

1. draft the final customer answer
2. perform retrieval itself
3. ask for wide clarification by default

### 6.2 Retrieval

Backend retrieval remains one pass only in the primary runtime:

1. collect evidence from the published KB
2. apply existing evidence policy and deterministic selection
3. build one evidence bundle for the specialist

The primary runtime explicitly disables:

1. retrieval refinement
2. extra retrieval pass
3. evidence-selector agent calls

### 6.3 Domain specialist

Exactly one domain specialist receives:

1. query
2. conversation history
3. routed case frame
4. selected evidence bundle

Specialist responsibilities:

1. answer directly
2. bind factual claims to evidence ids
3. keep unknowns narrow
4. provide structured fields that can be rendered locally

### 6.4 Local finalization

The backend keeps:

1. citation sanitation
2. unsupported-claim downgrading
3. mode resolution
4. answer shaping
5. structured-answer output

The backend removes from the primary live path:

1. evidence judge
2. answer composer
3. citation curator
4. citation selector

## 7. Contracts

### 7.1 Route additions

`SupportQuestionRoute` and `SupportCaseFrame` gain `primary_domain`.

Values:

1. `openapi`
2. `deployment`
3. `docs`

### 7.2 New adapter methods

Optional adapter methods:

1. `planSupportDispatch(...)`
2. `writeOpenApiDomainAnswer?(...)`
3. `writeDeploymentDomainAnswer?(...)`
4. `writeDocsDomainAnswer?(...)`

These remain optional so existing tests and rollback paths still work.

### 7.3 Runtime selection

Primary runtime selection in `runSupportSearchAgent()` becomes:

1. if current support-main gate is enabled and domain-runtime methods exist, use the new supervisor-domain runtime
2. else if current support-main methods exist, use the older single-agent runtime
3. else use legacy multi-stage fallback

This keeps one clean rollback layer without making the old path the default.

## 8. Output Quality Guarantees

The new path preserves the current output contract:

1. direct answer
2. what to do now
3. minimum missing info
4. grounded citations

The final answer still uses the existing local answer-building helpers so that:

1. render variants stay stable
2. unsupported claims are still stripped
3. customer-facing wording does not regress into internal pipeline language

## 9. What The New Runtime Explicitly Refuses To Do

The primary runtime will not:

1. chain more than two LLM calls
2. run planner plus router plus evidence planner plus specialist plus judge plus composer
3. rely on extra retrieval passes to become correct
4. add query-specific if/else patches as the main fix

## 10. Verification Targets

This branch is only acceptable if tests prove:

1. the supervisor-domain runtime is preferred when available
2. the new path makes only one retrieval pass
3. the new path does not call judge/composer/legacy route stages
4. the new path still returns structured answers with grounded citations
5. the old support-main path still works as rollback when domain methods are absent

## 11. Rollout And Risk

Risk is moderate because the changes touch `support-agent.ts`, `ws-adapter.ts`, and the OpenClaw contract surface.

Risk is controlled because:

1. the new adapter methods are optional
2. the old support-main path remains intact as fallback
3. the legacy path remains intact as last-resort rollback

This branch is intentionally a functional rebuild of the primary runtime, not another patch layer on top of the old orchestration.
