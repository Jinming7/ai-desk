# Support Domain Agent Runtime Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline support-runtime heuristics with externalized domain contracts and contract-driven prompt loading, then start removing local support-specific semantic repair logic.

**Architecture:** Keep the existing support runtime entrypoint, but move stage behavior into versioned contract files under `docs/agents/support-runtime/`. Add a runtime registry/loader so OpenClaw stages consume external contracts, then progressively delete local domain-specific rewrites and answer-recovery helpers.

**Tech Stack:** TypeScript, Node.js, OpenClaw WS adapter, repository KB metadata, markdown/json contract files

---

### Task 1: Add Contract Documents And Registry

**Files:**
- Create: `docs/27_AI_Support_Agent_Rebuild_Part_07_Domain_Agent_Skills_And_Contracts.md`
- Create: `docs/agents/support-runtime/registry.json`
- Create: `docs/agents/support-runtime/support-supervisor.md`
- Create: `docs/agents/support-runtime/support-openapi-agent.md`
- Create: `docs/agents/support-runtime/support-deploy-docs-agent.md`
- Create: `docs/agents/support-runtime/support-integrations-agent.md`
- Create: `docs/agents/support-runtime/support-product-behavior-agent.md`
- Create: `docs/agents/support-runtime/support-troubleshooting-agent.md`
- Create: `docs/agents/support-runtime/support-evidence-judge.md`

- [ ] **Step 1: Verify the new doc set is missing before creation**

Run: `find docs/agents/support-runtime -maxdepth 1 -type f 2>/dev/null || true`
Expected: empty or missing directory

- [ ] **Step 2: Add the spec and contract files**

Add the files listed above.

- [ ] **Step 3: Verify the new files exist**

Run: `find docs/agents/support-runtime -maxdepth 1 -type f | sort`
Expected: all contract files listed

- [ ] **Step 4: Commit**

```bash
git add docs/27_AI_Support_Agent_Rebuild_Part_07_Domain_Agent_Skills_And_Contracts.md docs/agents/support-runtime docs/superpowers/plans/2026-04-15-support-domain-agent-runtime-reset.md
git commit -m "docs: add support domain agent contracts"
```

### Task 2: Add Runtime Contract Loader

**Files:**
- Create: `apps/api/src/modules/ai/support-contracts.ts`
- Test: `apps/api/src/modules/ai/support-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadSupportContractRegistry, loadSupportContractText } from "./support-contracts.js";

test("loadSupportContractRegistry loads support runtime registry", () => {
  const registry = loadSupportContractRegistry();
  assert.equal(registry.version, "2026-04-15");
  assert.ok(registry.domains.some((item) => item.id === "deployment"));
});

test("loadSupportContractText loads a domain contract body", () => {
  const text = loadSupportContractText("docs/agents/support-runtime/support-deploy-docs-agent.md");
  assert.match(text, /Support Deploy Docs Agent Contract/);
  assert.match(text, /Near-Match Rejection Rules/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/api/src/modules/ai/support-contracts.test.ts`
Expected: FAIL because loader module does not exist yet

- [ ] **Step 3: Write minimal implementation**

```ts
import fs from "node:fs";
import path from "node:path";

type SupportContractRegistry = {
  version: string;
  contracts: Record<string, string>;
  domains: Array<{
    id: string;
    contract_path: string;
    owned_product_areas: string[];
    owned_source_families: string[];
    preferred_doc_kinds: string[];
    exact_signal_types: string[];
  }>;
};

const repoRoot = path.resolve(__dirname, "../../../../");

export function loadSupportContractRegistry(): SupportContractRegistry {
  const raw = fs.readFileSync(path.join(repoRoot, "docs/agents/support-runtime/registry.json"), "utf8");
  return JSON.parse(raw) as SupportContractRegistry;
}

export function loadSupportContractText(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test apps/api/src/modules/ai/support-contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ai/support-contracts.ts apps/api/src/modules/ai/support-contracts.test.ts
git commit -m "feat: load support runtime contracts from docs"
```

### Task 3: Replace Embedded Supervisor Prompt With External Contract

**Files:**
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- Modify: `apps/api/src/modules/ai/types.ts`
- Test: `apps/api/src/modules/ai/support-agent.integration-route.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test asserting the dispatcher accepts the expanded domains:

```ts
assert.equal(parsed.route.primary_domain, "integrations");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/api/src/modules/ai/support-agent.integration-route.test.ts`
Expected: FAIL because domain enum or parser still rejects the new domain

- [ ] **Step 3: Extend the domain type**

Change:

```ts
export type SupportDomain = "openapi" | "deployment" | "docs";
```

To:

```ts
export type SupportDomain = "openapi" | "deployment" | "integrations" | "product" | "troubleshooting";
```

- [ ] **Step 4: Load the external supervisor contract in `ws-adapter.ts`**

Replace embedded supervisor prompt rules with:

```ts
const contract = loadSupportContractText(loadSupportContractRegistry().contracts.supervisor);
const prompt = [
  contract,
  "Return ONLY valid JSON with keys:",
  "primary_domain(openapi|deployment|integrations|product|troubleshooting),",
  "...",
  `user_query: ${input.query}`
].join("\n");
```

- [ ] **Step 5: Normalize the new domains**

Update the `inferSupportDomain(...)` logic to accept the expanded enum and prefer explicit routed domains.

- [ ] **Step 6: Run the focused test**

Run: `npx tsx --test apps/api/src/modules/ai/support-agent.integration-route.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/infrastructure/openclaw/ws-adapter.ts apps/api/src/modules/ai/types.ts apps/api/src/modules/ai/support-agent.integration-route.test.ts
git commit -m "feat: externalize support supervisor contract"
```

### Task 4: Replace Embedded Specialist And Judge Prompts With External Contracts

**Files:**
- Modify: `apps/api/src/infrastructure/openclaw/ws-adapter.ts`
- Modify: `apps/api/src/modules/ai/support-contracts.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Add a focused test around contract resolution:

```ts
assert.match(resolveDomainContract("deployment"), /Support Deploy Docs Agent Contract/);
assert.match(resolveJudgeContract(), /Support Evidence Judge Contract/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/api/src/modules/ai/support-agent.test.ts --test-name-pattern='contract'`
Expected: FAIL because contract resolution helpers do not exist yet

- [ ] **Step 3: Implement domain contract resolution**

Add helpers:

```ts
export function resolveDomainContract(domain: SupportDomain): string { ... }
export function resolveEvidenceJudgeContract(): string { ... }
```

- [ ] **Step 4: Replace specialist prompt arrays**

For each specialist stage, build prompts from:

- domain contract text
- stage-specific output schema
- current route/case frame/evidence bundle

The domain contract must appear before runtime context lines.

- [ ] **Step 5: Replace evidence judge prompt**

Build the judge prompt from `support-evidence-judge.md` plus structured runtime inputs.

- [ ] **Step 6: Run focused tests**

Run: `npx tsx --test apps/api/src/modules/ai/support-agent.test.ts`
Expected: PASS for touched tests

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/infrastructure/openclaw/ws-adapter.ts apps/api/src/modules/ai/support-contracts.ts apps/api/src/modules/ai/support-agent.test.ts
git commit -m "feat: externalize support domain and judge contracts"
```

### Task 5: Start Removing Local Domain-Specific Repair Logic

**Files:**
- Modify: `apps/api/src/modules/ai/support-agent.ts`
- Test: `apps/api/src/modules/ai/support-agent.test.ts`

- [ ] **Step 1: Write the failing regression test**

Write a test that proves a deployment architecture question must fail closed when only near-match docs are retrieved.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test apps/api/src/modules/ai/support-agent.test.ts --test-name-pattern='fail closed'`
Expected: FAIL because local draft recovery or rerank still manufactures a grounded answer

- [ ] **Step 3: Remove one class of forbidden local logic**

Delete or neutralize one targeted class first:

- deployment-specific draft recovery, or
- domain-specific rerank override, or
- local route reconciliation

Replace it only with generic fail-closed evidence gating.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx --test apps/api/src/modules/ai/support-agent.test.ts`
Expected: PASS for focused touched cases

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ai/support-agent.ts apps/api/src/modules/ai/support-agent.test.ts
git commit -m "refactor: remove local support answer repair logic"
```

### Task 6: Verification And Preview Evaluation

**Files:**
- Modify: `apps/api/src/tests/ai-support-agent.business-eval.ts`
- Modify: `apps/api/src/tests/evals/fixtures/support-runtime-scenarios.json`

- [ ] **Step 1: Add domain visibility assertions**

Add checks that diagnostics expose the chosen `primary_domain` and that the domain matches the scenario.

- [ ] **Step 2: Add deployment fail-closed business case**

Add a case asserting near-match deployment docs do not produce a false grounded topology answer.

- [ ] **Step 3: Run local focused verification**

Run: `npx tsx --test apps/api/src/tests/ai-support-agent.business-eval.ts`
Expected: PASS

- [ ] **Step 4: Run preview validation**

Run the preview business validation with `vercel curl`.

Expected:

- route/domain visible and correct
- deployment architecture questions use direct deployment evidence or fail closed
- no generic same-domain noise is promoted into the direct answer

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/ai-support-agent.business-eval.ts apps/api/src/tests/evals/fixtures/support-runtime-scenarios.json
git commit -m "test: add support domain contract business coverage"
```
