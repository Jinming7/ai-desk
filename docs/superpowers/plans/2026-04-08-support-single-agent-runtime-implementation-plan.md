# Support Single-Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the user-facing multi-agent support request path with a single OpenClaw support agent that performs OpenClaw-driven retrieval and returns grounded customer answers that remain bound to the published KB snapshot.

**Architecture:** Replace the current multi-agent support hot path with one OpenClaw `support-main` run that returns a structured answer draft, claims, references, and retrieval queries. The backend reconciles those returned references against the active published KB snapshot, maps them onto canonical evidence ids, and only then materializes the customer-facing answer. Finally align the live cloud agent instructions and verify the simplified runtime end to end with business queries.

**Tech Stack:** Node.js 20.20.1, TypeScript, Express API, OpenClaw WS adapter, PostgreSQL-backed KB publication runtime, node:test, Vercel preview runtime, live Alibaba Cloud OpenClaw gateway.

---

### Task 1: Baseline Bootstrap And Capability Probe

**Files:**
- Create: `docs/superpowers/specs/2026-04-08-support-single-agent-runtime-design.md`
- Modify: none
- Test: command-only capability probe and environment bootstrap

- [ ] **Step 1: Bootstrap isolated worktree dependencies**

Run:

```bash
npm install
```

Expected:

- root workspace dependencies install successfully
- `apps/api/node_modules` resolve correctly through workspace install

- [ ] **Step 2: Verify current baseline build in the isolated worktree**

Run:

```bash
npm --workspace @nexusflow/api run build
```

Expected:

- build exits `0`
- any failure at this step is treated as baseline/environment blocker, not as part of the new implementation

- [ ] **Step 3: Probe live OpenClaw support topology and retrieval capability**

Run the existing live-gateway inspection path or an equivalent authenticated probe and record:

```text
- configured live support agent ids
- whether one chosen support-main candidate can execute chat/send runs
- whether retrieval-capable tool usage can be observed or inferred safely
- whether returned references already include evidence-safe fields
```

Expected:

- no guesswork remains about live capability gaps

- [ ] **Step 4: Commit milestone**

```bash
git add docs/superpowers/specs/2026-04-08-support-single-agent-runtime-design.md docs/superpowers/plans/2026-04-08-support-single-agent-runtime-implementation-plan.md
git commit -m "docs: define single-agent support runtime plan"
```

### Task 2: Single-Agent Contract And Reference Reconciliation

**Files:**
- Modify: `apps/api/src/infrastructure/openclaw/types.ts`
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Modify: `apps/api/src/modules/ai/types.ts`
- Test: `apps/api/src/infrastructure/openclaw/ws-adapter.test.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`

- [ ] **Step 1: Write failing contract tests for the single-agent output schema**

Add tests that require:

```ts
runSupportMainAgent(...)
```

to parse and preserve:

```ts
reference_id
references[]
retrieval_queries[]
claims[].reference_ids
missing_critical_info[]
question_type
render_variant
```

- [ ] **Step 2: Write failing reconciliation tests for published-snapshot grounding**

Add tests that require:

```ts
runSupportSearchAgent(...)
```

to:

```ts
- accept only claims whose reference_ids reconcile to published evidence
- downgrade unresolved or ambiguous references
- expose canonical evidence ids only after reconciliation
- bypass old planner/router/specialist/judge/composer stages when single-agent mode is enabled
```

- [ ] **Step 3: Run the focused tests and verify they fail for the intended reason**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
```

Expected:

- new assertions fail because the single-agent contract and reconciliation path do not exist yet

- [ ] **Step 4: Implement minimal contract and reconciliation changes**

Required implementation scope:

```text
- add OpenClawSupportMain input/output types
- add OpenClawAdapter.runSupportMainAgent(...)
- implement ws-adapter single-agent JSON prompt + parsing
- add backend reconciliation from agent-returned references to canonical published evidence ids
- ensure unresolved references cannot survive as verified delivery
```

- [ ] **Step 5: Re-run focused tests and verify they pass**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
```

Expected:

- focused single-agent contract tests pass

- [ ] **Step 6: Commit milestone**

```bash
git add apps/api/src/infrastructure/openclaw/types.ts apps/api/src/infrastructure/openclaw/ws-adapter.ts apps/api/src/modules/ai/support-agent.ts apps/api/src/modules/ai/types.ts apps/api/src/infrastructure/openclaw/ws-adapter.test.ts apps/api/src/modules/ai/support-agent.test.ts
git commit -m "fix: add single-agent support contract"
```

### Task 3: Single-Agent Runtime Path

**Files:**
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Modify: `apps/api/src/modules/ai/agent-router.ts`
- Modify: `apps/api/src/modules/ai/support-runtime-policy.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/infrastructure/openclaw/types.ts`
- Modify: `apps/api/src/infrastructure/openclaw/mock-adapter.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`
- Test: `apps/api/src/modules/ai/support-agent-runtime-budget.test.ts`

- [ ] **Step 1: Write failing tests for single-agent runtime selection**

Add tests that prove:

```ts
- FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME=true bypasses route/evidence-plan/planner/specialist/judge/composer stages
- single-agent mode emits runtime_mode=single_agent diagnostics
- single-agent mode still returns structured support answers
- single-agent mode still rejects unsupported uncited factual claims
```

- [ ] **Step 2: Run focused tests and verify they fail first**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
```

Expected:

- new single-agent assertions fail because runtime mode does not exist yet

- [ ] **Step 3: Implement the minimal single-agent path**

Required implementation scope:

```text
- add FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME
- add stage binding for support-main
- implement single-agent runtime path in support-agent.ts
- keep backend citation and unsupported-claim validation
- leave current path available behind the flag as rollback fallback
```

- [ ] **Step 4: Re-run focused tests and verify they pass**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
```

Expected:

- single-agent runtime tests pass

- [ ] **Step 5: Commit milestone**

```bash
git add apps/api/src/modules/ai/support-agent.ts apps/api/src/modules/ai/agent-router.ts apps/api/src/modules/ai/support-runtime-policy.ts apps/api/src/config/env.ts apps/api/src/infrastructure/openclaw/types.ts apps/api/src/infrastructure/openclaw/mock-adapter.ts apps/api/src/modules/ai/support-agent.test.ts apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
git commit -m "feat: add single-agent support runtime"
```

### Task 4: Runtime Stability And Timeout Closure

**Files:**
- Modify: `apps/api/src/modules/ai/service.ts`
- Modify: `apps/api/src/modules/ai/support-search-jobs.ts`
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Test: `apps/api/src/modules/ai/support-agent-runtime-budget.test.ts`

- [ ] **Step 1: Write failing tests for terminal-state timing**

Add tests that prove:

```ts
- single-agent interactive requests do not keep the front-end polling indefinitely
- async jobs keep heartbeats aligned with stage progress and terminate inside the configured budget
```

- [ ] **Step 2: Run focused tests and verify they fail first**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
```

Expected:

- the new budget/terminal-state assertions fail before the fix

- [ ] **Step 3: Implement the minimal timeout-closure changes**

Required implementation scope:

```text
- ensure simplified runtime reports stage progress coherently
- ensure async jobs cannot remain stuck in non-terminal state past the configured window
- keep front-end polling and job lifecycle aligned
```

- [ ] **Step 4: Re-run focused tests and verify they pass**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
```

Expected:

- terminal-state timing tests pass

- [ ] **Step 5: Commit milestone**

```bash
git add apps/api/src/modules/ai/service.ts apps/api/src/modules/ai/support-search-jobs.ts apps/api/src/modules/ai/support-agent.ts apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
git commit -m "fix: close support runtime timeout gaps"
```

### Task 5: Live OpenClaw Agent Alignment

**Files:**
- Modify: live cloud OpenClaw `agent.md` for the selected support-main agent
- Modify: local operator notes only if required for reproducibility
- Test: live authenticated OpenClaw run trace

- [ ] **Step 1: Select the live support-main agent target**

Record:

```text
- chosen agent id
- why it is safe to reuse or repurpose
- which retired support agent ids remain mapped only for rollback
```

- [ ] **Step 2: Update live agent instructions**

Required instruction content:

```text
- retrieve before answering
- return stable references with reference_id/title/sourceUrl/path/headingPath/snippet
- bind each factual claim to returned reference_ids
- do not confirm unsupported capabilities
- ask only minimum blocking clarification
- answer in support-engineer structure
- keep output JSON schema stable
```

- [ ] **Step 3: Verify the live agent responds under the new contract**

Run a live authenticated probe and confirm:

```text
- single agent session is used
- returned references reconcile cleanly to the published KB snapshot
- answer output follows the required schema
```

- [ ] **Step 4: Commit milestone**

```bash
git add <only local reproducibility docs if any>
git commit -m "chore: align live support agent contract"
```

### Task 6: Full Verification And Production Readiness Review

**Files:**
- Modify: any final fixes required by the gates above
- Test: build and focused regression suite

- [ ] **Step 1: Run build and focused support regressions**

Run:

```bash
npm --workspace @nexusflow/api run build
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
```

Expected:

- build passes
- focused regressions pass

- [ ] **Step 2: Replay business queries in preview-equivalent runtime**

Run preview-equivalent replays for:

```text
What scope is required for the issue comment API?
Does ONESQL support ORDER BY and GROUP BY clauses?
GitHub integration callback page shows 404 after authorization. What should I check?
CPU, memory, and disk requirements per node (50 / 200 / 500+ users)?
```

Expected:

- answers are grounded
- citations are coherent
- diagnostics show single-agent runtime mode

- [ ] **Step 3: Review live OpenClaw traces**

Verify:

```text
- no retired multi-agent request path is still active
- claim-level reference bindings reconcile to delivered citation ids
- no unsupported capability conclusion leaks through
```

- [ ] **Step 4: Commit final milestone**

```bash
git add <final verified changes>
git commit -m "fix: productionize single-agent support runtime"
```

- [ ] **Step 5: Produce production-readiness review**

The final review must explicitly answer:

```text
- what is included
- what is intentionally not included
- what verification passed
- what verification did not run
- whether support-agent can honestly be called production-ready
```
