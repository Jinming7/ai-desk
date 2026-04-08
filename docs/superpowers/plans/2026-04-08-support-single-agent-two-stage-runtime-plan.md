# Support Single-Agent Two-Stage Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disproven one-call `support-main` runtime with a production-safe two-stage single-agent runtime that keeps one support agent while moving retrieval execution back to the published-KB backend path.

**Architecture:** Stage 1 calls `support-main` in `plan` mode to produce route, case frame, and retrieval queries only. The backend executes published-snapshot retrieval with those queries, then Stage 2 calls the same `support-main` in `draft` mode with provided evidence so the agent drafts the answer without performing retrieval. Citation reconciliation, verification, and answer materialization remain backend-controlled.

**Tech Stack:** TypeScript, node:test, OpenClaw WS adapter, mock adapter, support-agent orchestration, published KB retrieval orchestrator, live Alibaba Cloud OpenClaw gateway.

---

### Task 1: Freeze Two-Stage Contract

**Files:**
- Modify: `apps/api/src/infrastructure/openclaw/types.ts`
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- Modify: `apps/api/src/infrastructure/openclaw/mock-adapter.ts`
- Test: `apps/api/src/infrastructure/openclaw/ws-adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests for `plan` mode**

Require `support-main` plan mode to parse:

```ts
route
case_frame
retrieval_queries
```

and to avoid requiring:

```ts
draft_answer
references
```

- [ ] **Step 2: Write failing adapter tests for `draft` mode**

Require `support-main` draft mode to accept backend-provided evidence and parse:

```ts
draft_answer
references
claims[].reference_ids
```

while not expecting the agent to perform retrieval in that call.

- [ ] **Step 3: Run adapter tests to verify they fail first**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
```

Expected:

- new two-stage contract assertions fail

### Task 2: Replace Single-Agent Runtime Orchestration

**Files:**
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Modify: `apps/api/src/modules/ai/support-agent.test.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`

- [ ] **Step 1: Write failing runtime test for `plan -> retrieval -> draft`**

Require single-agent mode to:

```ts
- call plan stage first
- run backend retrieval with plan-stage queries
- call draft stage with provided evidence only
- bypass legacy route/evidence-planner/case-planner/specialist/judge/composer stages
- keep only reconciled citations in the final answer
```

- [ ] **Step 2: Run runtime tests to verify they fail first**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
```

Expected:

- old one-call runtime assertions break against the new two-stage expectation

- [ ] **Step 3: Implement minimal runtime change**

Implementation scope:

```text
- replace runSupportMainAgent with plan/draft split methods
- keep backend retrieval and reconciliation authoritative
- keep downstream verification/citation materialization intact
```

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
npx tsx --test apps/api/src/infrastructure/openclaw/ws-adapter.test.ts
npx tsx --test apps/api/src/modules/ai/support-agent.test.ts
```

Expected:

- two-stage tests pass

### Task 3: Verification And Live Alignment

**Files:**
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- Modify: live cloud `support-main` agent files via gateway file APIs
- Test: `apps/api/src/modules/ai/support-agent-runtime-budget.test.ts`

- [ ] **Step 1: Run local regression gates**

Run:

```bash
npx tsx --test apps/api/src/modules/ai/support-agent-runtime-budget.test.ts
npm --workspace @nexusflow/api run build
```

Expected:

- runtime budget tests pass
- API build passes

- [ ] **Step 2: Commit milestone**

```bash
git add docs/superpowers/plans/2026-04-08-support-single-agent-two-stage-runtime-plan.md apps/api/src/infrastructure/openclaw/types.ts apps/api/src/infrastructure/openclaw/ws-adapter.ts apps/api/src/infrastructure/openclaw/mock-adapter.ts apps/api/src/infrastructure/openclaw/ws-adapter.test.ts apps/api/src/modules/ai/support-agent.ts apps/api/src/modules/ai/support-agent.test.ts
git commit -m "fix: switch support-main to two-stage runtime"
```

- [ ] **Step 3: Update live `support-main` instructions**

Require live `AGENTS.md` to state:

```text
- plan mode must not retrieve; return retrieval queries only
- draft mode must not retrieve; answer only from provided evidence
- claims must anchor to reference_id only
```

- [ ] **Step 4: Run live validation**

Validate:

```text
- plan-only call succeeds
- draft-only call succeeds
- preview business questions finish within budget
- returned answers stay grounded and business-useful
```
