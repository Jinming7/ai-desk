# Support Supervisor Domain Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current primary support request path with a supervisor-plus-domain-specialist runtime that uses one retrieval pass, one specialist call, and local finalization while preserving rollback compatibility.

**Architecture:** Add a new optional domain-runtime contract to the OpenClaw adapter, route `runSupportSearchAgent()` to that runtime when the existing support-main gate is active, and keep the current support-main and legacy runtimes as fallbacks. The new path uses `planner` as the supervisor stage, deterministic backend evidence selection, one domain specialist prompt, and local answer/citation finalization.

**Tech Stack:** Node.js 20, TypeScript, node:test, OpenClaw WS adapter, existing support-agent answer builders, Vercel preview runtime.

---

### Task 1: Define The New Runtime Contract

**Files:**
- Create: `docs/superpowers/specs/2026-04-09-support-supervisor-domain-runtime-design.md`
- Create: `docs/superpowers/plans/2026-04-09-support-supervisor-domain-runtime.md`
- Modify: `apps/api/src/modules/ai/types.ts`
- Modify: `apps/api/src/infrastructure/openclaw/types.ts`
- Test: `apps/api/src/infrastructure/openclaw/ws-adapter.test.ts`

- [ ] **Step 1: Add a failing adapter-contract test**

Add tests that require:

```ts
planSupportDispatch(...)
writeOpenApiDomainAnswer(...)
writeDeploymentDomainAnswer(...)
writeDocsDomainAnswer(...)
```

to preserve:

```ts
primary_domain
retrieval_queries
question_type
render_variant
claims[].evidence_ids
```

- [ ] **Step 2: Run the focused WS adapter test and verify it fails first**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
```

Expected:

- the new dispatch/domain-specialist assertions fail because the methods do not exist yet

- [ ] **Step 3: Implement the minimal contract surface**

Required scope:

```text
- add SupportDomain typing
- add primary_domain to route/case-frame contracts
- add optional domain-runtime methods to OpenClawAdapter
- implement parsing tests and adapter prompt coverage
```

- [ ] **Step 4: Re-run the focused WS adapter test**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
```

Expected:

- the new adapter contract tests pass

- [ ] **Step 5: Commit contract milestone**

```bash
git add docs/superpowers/specs/2026-04-09-support-supervisor-domain-runtime-design.md docs/superpowers/plans/2026-04-09-support-supervisor-domain-runtime.md apps/api/src/modules/ai/types.ts apps/api/src/infrastructure/openclaw/types.ts apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
git commit -m "docs: define supervisor domain support runtime"
```

### Task 2: Add Failing Runtime Tests

**Files:**
- Modify: `apps/api/src/modules/ai/support-agent.test.ts`
- Modify: `apps/api/src/infrastructure/openclaw/mock-adapter.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`

- [ ] **Step 1: Add a failing support-runtime selection test**

Require `runSupportSearchAgent()` to prove:

```ts
- when support-main gating is active and planSupportDispatch exists, the new runtime is preferred
- the new runtime skips routeSupportQuestion, planSupportEvidence, planSupportCase, judgeSupportAnswer, and composeCustomerAnswer
- runtime_mode becomes "supervisor_domain"
```

- [ ] **Step 2: Add a failing one-pass retrieval test**

Require:

```ts
- retrieval_extra is skipped
- retrieval refinement is never called
- diagnostics stage_budget forces one pass
```

- [ ] **Step 3: Add a failing local-finalization test**

Require:

```ts
- unsupported claims without evidence ids are removed
- citations come only from sanitized evidence ids
- support answer remains structured
```

- [ ] **Step 4: Run the focused support-agent test and verify it fails first**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
```

Expected:

- the new runtime assertions fail because the path does not exist yet

### Task 3: Implement The New Runtime

**Files:**
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- Modify: `apps/api/src/infrastructure/openclaw/mock-adapter.ts`
- Modify: `apps/api/src/modules/ai/agent-router.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`
- Test: `apps/api/src/infrastructure/openclaw/ws-adapter.test.ts`

- [ ] **Step 1: Implement supervisor dispatch in the adapter**

Required scope:

```text
- add a planner-backed dispatch prompt
- emit primary_domain plus coherent route/case-frame output
- keep retrieval planning single-pass by contract
```

- [ ] **Step 2: Implement the three domain specialist prompts**

Required scope:

```text
- openapi specialist
- deployment specialist
- docs specialist
- each uses only provided evidence
```

- [ ] **Step 3: Implement the new runtime in support-agent.ts**

Required scope:

```text
- add runSupervisorDomainSupportSearch(...)
- prefer it before the older single-agent path when methods exist
- keep evidence selection deterministic and local
- keep verification/citation shaping local
- preserve support-main and legacy fallbacks
```

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
```

Expected:

- both focused suites pass

- [ ] **Step 5: Run a broader regression check**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
```

Expected:

- no runtime-budget regression from the new path

### Task 4: Verify, Commit, And Push

**Files:**
- Modify: scoped files from Tasks 1-3 only
- Test: command verification only

- [ ] **Step 1: Verify changed-file status**

Run:

```bash
git status --short
git diff --stat
```

Expected:

- only the planned files are changed

- [ ] **Step 2: Commit the implementation**

```bash
git add apps/api/src/modules/ai/types.ts apps/api/src/infrastructure/openclaw/types.ts apps/api/src/infrastructure/openclaw/ws-adapter.ts apps/api/src/infrastructure/openclaw/mock-adapter.ts apps/api/src/modules/ai/support-agent.ts apps/api/src/modules/ai/agent-router.ts apps/api/src/infrastructure/openclaw/ws-adapter.test.ts apps/api/src/modules/ai/support-agent.test.ts docs/superpowers/specs/2026-04-09-support-supervisor-domain-runtime-design.md docs/superpowers/plans/2026-04-09-support-supervisor-domain-runtime.md
git commit -m "feat: add supervisor domain support runtime"
```

- [ ] **Step 3: Push the branch**

```bash
git push origin feature/support-supervisor-domain-runtime-20260409
```

Expected:

- remote branch updates successfully
