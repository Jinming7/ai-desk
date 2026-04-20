import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadSupportContractRegistry,
  loadSupportContractText,
  resetSupportContractCachesForTest,
  resolveAnswerComposerContract,
  resolveDomainContract,
  resolveEvidenceJudgeContract,
  resolveSupervisorContract
} from "./support-contracts.js";

test("loadSupportContractRegistry loads the support runtime registry", () => {
  const registry = loadSupportContractRegistry();

  assert.equal(registry.version, "2026-04-15");
  assert.ok(registry.domains.some((item) => item.id === "integrations"));
  assert.ok(registry.domains.some((item) => item.id === "product"));
});

test("loadSupportContractText reads domain contract markdown from docs", () => {
  const text = loadSupportContractText("docs/agents/support-runtime/support-deploy-docs-agent.md");

  assert.match(text, /Support Deploy Docs Agent Contract/);
  assert.match(text, /Near-Match Rejection Rules/);
});

test("resolveDomainContract maps the legacy docs alias onto the product contract", () => {
  const text = resolveDomainContract("docs");

  assert.match(text, /Support Product Behavior Agent Contract/);
});

test("resolveSupervisorContract, resolveEvidenceJudgeContract, and resolveAnswerComposerContract load runtime contracts", () => {
  assert.match(resolveSupervisorContract(), /Support Supervisor Contract/);
  assert.match(resolveEvidenceJudgeContract(), /Support Evidence Judge Contract/);
  assert.match(resolveAnswerComposerContract(), /Support Answer Composer/);
});

test("loadSupportContractText falls back to bundled dist contracts when repo docs are unavailable", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "support-contracts-dist-"));
  const distContractsDir = path.join(tempRoot, "apps", "api", "dist", "docs", "agents", "support-runtime");
  fs.mkdirSync(distContractsDir, { recursive: true });
  const docsRoot =
    [path.resolve(process.cwd(), "docs"), path.resolve(process.cwd(), "..", "..", "docs")].find((candidate) => fs.existsSync(candidate)) ??
    path.resolve(process.cwd(), "docs");

  fs.copyFileSync(
    path.join(docsRoot, "agents", "support-runtime", "registry.json"),
    path.join(distContractsDir, "registry.json")
  );
  fs.copyFileSync(
    path.join(docsRoot, "agents", "support-runtime", "support-supervisor.md"),
    path.join(distContractsDir, "support-supervisor.md")
  );

  const originalCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    resetSupportContractCachesForTest();

    const text = loadSupportContractText("docs/agents/support-runtime/support-supervisor.md");
    const registry = loadSupportContractRegistry();

    assert.match(text, /Support Supervisor Contract/);
    assert.equal(registry.version, "2026-04-15");
  } finally {
    process.chdir(originalCwd);
    resetSupportContractCachesForTest();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
