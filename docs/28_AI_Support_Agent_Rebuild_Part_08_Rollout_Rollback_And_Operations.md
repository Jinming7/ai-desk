# AI Support Agent Rebuild Plan Part 08

Date: 2026-04-01

Status: implementation-ready design

Required pre-read:

1. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/AGENTS.md`
2. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/20_AI_Support_Agent_Rebuild_Part_01_System_Model_And_Single_DB_Publishing.md`
3. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/21_AI_Support_Agent_Rebuild_Part_02_Single_DB_Build_Sync_Publish_And_Repair.md`
4. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/22_AI_Support_Agent_Rebuild_Part_03_Repository_Knowledge_Model_And_Retrieval_Units.md`
5. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/24_AI_Support_Agent_Rebuild_Part_04_Hybrid_Retrieval_And_Orchestration.md`
6. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/25_AI_Support_Agent_Rebuild_Part_05_OpenClaw_Runtime_And_Stage_Contracts.md`
7. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/26_AI_Support_Agent_Rebuild_Part_06_Evaluation_Acceptance_And_Regression.md`
8. `/Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/27_AI_Support_Agent_Rebuild_Part_07_KB_Build_Pipeline_And_Cleanup_Compatibility.md`

This part must be implemented together with the constraints defined in `AGENTS.md`, Part 01, Part 02, Part 03, Part 04, Part 05, Part 06, and Part 07.

If this document appears to conflict with an earlier part, the earlier part wins unless explicitly revised first.

Scope:

- define how the rebuilt KB, retrieval runtime, and support runtime move from implementation into safe staged rollout
- define gray release, shadow execution, promotion, rollback, and operator runbook rules
- define the operational controls required in a single shared DB environment
- define what must be monitored during rollout and what conditions require immediate rollback
- define what can begin now versus what must wait for earlier validation to finish

---

## 1. Pre-Implementation Confirmation

Before implementing anything in this part, the developer must confirm all of the following.

### 1.1 Hard prerequisites

Confirm:

- Part 02 publication-based serving is live and remains the only serving truth
- Part 03 repository KB artifacts are available at least in isolated or controlled build contexts
- Part 04 hybrid retrieval remains feature-flagged and not yet force-enabled for production
- Part 05 shared support runtime stage contracts exist
- Part 06 evaluation framework exists and can produce structured blocking reports
- the project still uses a single shared DB

If any of the above is false or unknown, stop and re-check earlier parts before implementing rollout or rollback logic.

### 1.2 This part defines rollout operations, not feature design

This part defines:

- rollout stages
- shadow validation
- feature flag enablement order
- publication promotion rules
- rollback triggers
- operational diagnostics

This part does **not** define:

- new KB build semantics
- new retrieval algorithms
- new specialist prompt behavior
- historical data cleanup execution

Those belong to earlier or later parts.

### 1.3 Shared DB safety confirmation

Because the project uses one shared DB:

- rollout must never rely on unsafe test writes into the production-visible knowledge space
- promotion and rollback must operate through publication pointers and feature flags, not ad-hoc row mutation
- any rollback must be executable without deleting live rows

If the proposed operational flow depends on direct row deletion, stop and redesign first.

---

## 2. What This Part Delivers

This part answers one question:

> Once the rebuilt KB and support runtime exist, how do we turn them on safely without corrupting the shared DB or degrading customer-facing support quality?

The answer is:

- not by one big cutover
- not by switching all feature flags at once
- not by trusting local smoke tests alone

The system must move through explicit rollout stages:

1. isolated build validation
2. shared-DB-safe shadow validation
3. limited feature-flag enablement
4. controlled production rollout
5. reversible rollback

---

## 3. Frozen Rollout Principle

The rebuilt support system must be rolled out in a way that preserves three invariants:

1. production support reads only one published snapshot per scope
2. customer-facing answer quality must not regress silently
3. rollback must be operationally cheap and fast

Therefore:

- rollout must prefer pointer changes and flags over destructive rewrites
- every rollout step must have a precomputed rollback path
- every rollout step must have measurable gates from Part 06

The fixed rollout order is:

1. build and validate
2. publish into controlled non-production scope or isolated DB
3. shadow read and compare
4. limited enablement through flags
5. broaden scope only after stable diagnostics
6. keep prior known-good build and behavior readily restorable

---

## 4. Rollout Units

The rebuild has three independent rollout units. They must not be conflated.

### 4.1 KB rollout unit

This controls:

- which `build_version` is published for a given `knowledge_space`, repo, and branch

Examples:

- promote a new `support-local` published build
- later promote a new `support-prod` published build

### 4.2 Retrieval rollout unit

This controls:

- whether the support runtime uses the legacy retrieval path or the Part 04 hybrid retrieval stack

Examples:

- `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL=false`
- then enable for limited shadow or controlled traffic

### 4.3 Runtime rollout unit

This controls:

- whether the support runtime uses stricter Part 05 stage contracts and shared stage traces as the dominant behavior path

Examples:

- keeping old compatibility behaviors around diagnostics-only
- then tightening runtime enforcement later

Each unit must have its own rollout and rollback decision.

---

## 5. Rollout Environments In A Single Shared DB

Because there is only one DB, environment separation must be logical, not physical.

### 5.1 Knowledge spaces

Recommended spaces:

- `support-local`
- `support-preview`
- `support-shadow`
- `support-prod`

Rules:

- local development writes only to `support-local`
- preview validation writes only to `support-preview`
- shadow experiments may read production-like traffic but must not publish to `support-prod`
- only explicit production promotion may update `support-prod`

### 5.2 Runtime environment mapping

Runtime environment and knowledge space must remain explicit.

Never allow:

- local actor publishing to `support-prod`
- preview actor publishing to `support-prod`
- implicit cross-space promotion

### 5.3 Shared DB safe principle

Even if all spaces live in one DB:

- rollout decisions must behave as though they were different environments
- no rollout step may assume row deletion is safe
- rollback must switch publication or disable feature flags, not mutate arbitrary rows

---

## 6. Rollout Stages

### 6.1 Stage A: Build-side readiness

Required before any runtime exposure:

- Part 07 KB build pipeline completes
- build validation passes
- artifact counts look coherent
- same-build coherence holds
- no cross-build reference violations

Allowed actions:

- produce build outputs
- persist build-scoped artifacts
- generate embeddings
- collect cleanup hints

Not allowed yet:

- publish to production
- enable new retrieval path for customer-facing traffic

### 6.2 Stage B: Isolated DB or isolated-space verification

Required before any production-like rollout:

- run Part 03 and Part 04 on isolated DB if available
- otherwise use isolated `knowledge_space` with strict no-publish-to-prod rules
- execute Part 06 evaluation on the produced KB

Goal:

- prove the build and retrieval substrate actually work on real artifacts

### 6.3 Stage C: Shared-DB-safe shadow validation

At this stage:

- production-visible behavior remains unchanged
- new retrieval/runtime logic executes in shadow mode
- comparison reports are generated side-by-side

Required checks:

- retrieval delta vs baseline
- answer mode delta vs baseline
- stage-trace differences
- `kb_unavailable` false positive rate
- citation presence rate

Shadow mode must be:

- read-only against production-visible snapshot
- or read-only against controlled published non-prod snapshot

### 6.4 Stage D: Limited feature-flag enablement

At this stage:

- the new retrieval path or runtime path is enabled only behind explicit flags
- enablement must be reversible without migration or cleanup

Recommended order:

1. diagnostics-only instrumentation
2. hybrid retrieval for controlled internal traffic or allowlisted path
3. broader internal usage
4. production traffic enablement only after stable metrics

### 6.5 Stage E: Production rollout

At this stage:

- rollout must be deliberate
- changes must be traceable to a build, flag state, and evaluation report

Required before enabling:

- Part 06 gates are acceptable
- shadow validation is stable
- rollback plan is pre-checked
- prior known-good publication and prior known-good flag state are recorded

---

## 7. Publication Promotion Rules

### 7.1 Promotion unit

Promotion always means:

- update `kb_publications` to point one scope to one validated build

Promotion never means:

- mass-changing arbitrary rows
- toggling `is_active` as serving truth
- deleting old builds to make new build active

### 7.2 Promotion checklist

Before promoting any build:

- build validation passed
- artifact family coverage is acceptable
- embeddings are acceptable for enabled retrieval modes
- evaluation report is recorded
- target `knowledge_space` matches actor permissions
- rollback target is known

### 7.3 Production promotion checklist

Before promoting `support-prod`:

- non-prod or shadow validation completed
- retrieval and answer gates do not regress materially
- diagnostics pipeline is healthy
- operator knows the prior published build version
- rollback operator procedure is documented and ready

---

## 8. Feature Flag Strategy

### 8.1 Required flag categories

At minimum, rollout must be controlled through:

- retrieval flag
- runtime tightening flag
- embedding or rerank enhancement flags when relevant

Examples:

- `FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL`
- future rerank enablement flag
- future stricter contract enforcement flag

### 8.2 Flag rules

Flags must be:

- independently switchable
- diagnosable in logs and evaluation reports
- reversible without redeploying data

Flags must not:

- silently imply publication changes
- silently switch KB knowledge space
- couple multiple unrelated rollout units into one irreversible toggle

### 8.3 Enablement order

Recommended enablement order:

1. diagnostics-only
2. retrieval stack
3. rerank enhancements
4. stricter runtime contract enforcement

Do not invert this order unless explicitly justified.

---

## 9. Rollback Design

### 9.1 Primary rollback tools

Rollback should use only these primary tools:

- revert feature flag state
- repoint `kb_publications` to prior known-good build
- disable a new runtime path before touching data

### 9.2 What rollback must not depend on

Rollback must not require:

- deleting rows
- rebuilding the KB from scratch under emergency pressure
- manual mutation of many artifact tables
- restoring production behavior by re-enabling `is_active` semantics

### 9.3 Rollback trigger classes

Immediate rollback triggers:

- sustained `kb_unavailable` false positive spike
- unsupported claim spike
- citation disappearance
- wrong specialist routing spike
- production timeout or stage failure spike
- publication-scoped read integrity failure

Fast rollback triggers:

- measurable retrieval regression
- answer mode mismatch spike
- abnormal clarification increase
- shadow/baseline divergence above threshold

### 9.4 Rollback runbook

Every rollout unit must have a written runbook:

- current build version
- prior build version
- current flag state
- prior flag state
- command or endpoint to revert
- expected health signals after revert

---

## 10. Operational Diagnostics

### 10.1 Minimum required diagnostics

Operations must be able to inspect:

- active `knowledge_space`
- active publication build version
- retrieval path used
- runtime stage trace
- specialist family chosen
- answer mode
- citation count
- unresolved reason code
- key feature flag states

### 10.2 Rollout comparison diagnostics

During shadow or gray rollout, compare:

- baseline retrieval status vs new retrieval status
- baseline citation count vs new citation count
- baseline route vs new route
- baseline answer mode vs new answer mode
- baseline latency vs new latency

### 10.3 Operator-friendly summaries

The system should expose operator summaries that answer:

- what changed
- when it changed
- which build and flags are active
- what regressed
- what to roll back

---

## 11. Production Safety Rules

### 11.1 Must always remain true

These conditions must always remain true in production:

- runtime reads one coherent published snapshot
- customer-facing answer path remains the shared support-agent pipeline
- fallback behavior remains explicit
- citations remain grounded
- no production change requires destructive data cleanup

### 11.2 Must block rollout

Rollout must stop if:

- evaluation report is blocked
- shadow report is materially worse than baseline
- publication resolution is ambiguous
- diagnostics are missing
- rollback path is unclear

### 11.3 Must trigger incident review

Incident review is required if:

- wrong publication becomes visible to customer-facing runtime
- unsupported answer spike is observed after rollout
- rollback cannot restore prior behavior quickly

---

## 12. Recommended Operational Modules

Recommended implementation modules:

- rollout decision helper
- publication promotion audit helper
- feature-flag snapshot reporter
- shadow comparison reporter
- rollback runbook helper
- release-status endpoint or operator script

Recommended repository areas:

- `apps/api/src/modules/ai/release/*`
- `apps/api/src/modules/github-kb/release/*`
- `apps/api/src/tests/release/*`
- `docs/` for operator runbooks and release checklists

The final file layout may follow repository conventions, but rollout, rollback, and diagnostics responsibilities should remain separate.

---

## 13. Acceptance For This Part

This part is considered implemented successfully only if all of the following are true.

### 13.1 Rollout acceptance

- a new build can be promoted through explicit publication only
- feature flags can enable or disable new retrieval/runtime behavior independently
- shadow validation can compare baseline vs new behavior

### 13.2 Rollback acceptance

- prior published build can be restored without data deletion
- prior flag state can be restored quickly
- rollback instructions are documented and testable

### 13.3 Operational acceptance

- operator can determine the active build and flag state
- operator can determine whether the new path is active
- operator can detect whether rollback is needed from structured diagnostics

---

## 14. What This Part Explicitly Defers

This part does not yet define:

- historical KB data cleanup execution
- automatic flag orchestration
- automatic rollback controllers
- user-visible incident communication templates

Those may be added later, but they are not required to start safe staged rollout work.

---

## 15. Development Dependency Conclusion

### 15.1 Can start immediately in parallel

The following work may start now and may be developed in parallel:

- rollout decision helper
- publication promotion audit logging
- feature-flag snapshot reporting
- operator diagnostics endpoints or scripts
- shadow comparison reporting
- rollback runbook documentation

### 15.2 Can be developed now but must not cut production behavior yet

The following may be implemented now, but must not yet be used to change production behavior:

- shadow execution plumbing
- rollout status pages or reports
- flag-driven staged enablement code paths
- publication promotion dry-run helpers

These are operational scaffolding, not rollout approval by themselves.

### 15.3 Must wait for prior work before full execution

The following must wait before full execution:

- production enablement of Part 04 hybrid retrieval
- production enablement of stricter Part 05 runtime behavior
- production promotion of newly built Part 07 KB snapshots

Required preconditions:

- Part 03 isolated DB validation is complete
- Part 04 evaluation is acceptable
- Part 05 shared runtime is stable enough for gray rollout
- Part 06 gates are trusted

### 15.4 Must not be bundled into this part

Do not bundle the following into Part 08:

- historical data deletion
- rerank provider design work
- unrelated prompt rewrites
- new retrieval family design

Those are separate workstreams.

