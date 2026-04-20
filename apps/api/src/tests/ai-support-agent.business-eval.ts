import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { env, isSafeTestDatabaseUrl } from "../config/env.js";
import { pool } from "../db/client.js";
import { loadAnswerGoldenDataset, loadBuildValidationFixtureDataset, loadRegressionReplayDataset, loadRetrievalSeedDataset, loadRuntimeScenarioDataset } from "../modules/ai/evals/dataset-loader.js";
import { scoreAnswerCase, summarizeAnswerResults } from "../modules/ai/evals/answer-evaluator.js";
import { evaluateAcceptanceGates } from "../modules/ai/evals/gates.js";
import { scoreRetrievalCase, summarizeRetrievalResults } from "../modules/ai/evals/retrieval-evaluator.js";
import { scoreRuntimeScenarioCase, summarizeRuntimeResults } from "../modules/ai/evals/runtime-evaluator.js";
import type { AnswerObservation, BuildValidationFixtureCase, EvaluationMode, RetrievalObservation, RuntimeObservation } from "../modules/ai/evals/types.js";
import { summarizeBuildValidationFixtures } from "../modules/github-kb/evals/build-validation-summarizer.js";
import * as githubRepo from "../modules/github-kb/repository.js";
import { resolveRuntimeKnowledgeSpace } from "../modules/github-kb/runtime-space.js";
import { ensureDocsComKnowledgeBase, retrieveKnowledge } from "../modules/github-kb/service.js";
import type { KbBuild, KbKnowledgeSpace, RetrievalHit } from "../modules/github-kb/types.js";
import { formatLocalDbBlockedMessage, probeLocalDbReadiness } from "./helpers/local-db-readiness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type SearchResult = {
  result: {
    session_id: string;
    answer: string;
    answer_language: "zh" | "en";
    support_answer?: {
      mode?: "grounded" | "partial" | "clarification" | "handoff";
      question_type?: string;
      render_variant?: string;
      direct_answer?: string;
      why?: string[];
      what_to_do_now?: string[];
      still_need_to_confirm?: string[];
      sections?: Array<Record<string, unknown>>;
    };
    verification?: {
      verdict?: "verified" | "partial" | "unsupported";
    };
    citations: Array<{ id: string; title: string; source_url: string }>;
    retrieval_status: "grounded" | "no_results" | "kb_unavailable";
    unresolved_reason_code: string | null;
    clarification_round: number;
    follow_up_question: string | null;
    show_create_ticket_now: boolean;
    internal_diagnostics?: {
      route?: { question_type?: string };
      specialists_used?: string[];
      claim_graph?: Array<{ text?: string; verdict?: string }>;
      stage_trace?: RuntimeObservation["stageTrace"];
      orchestration_trace?: Array<{ stage?: string; agent_id?: string }>;
    };
  };
};

type EvalReport = {
  generated_at: string;
  mode: EvaluationMode;
  git_revision: string | null;
  knowledge_space: string;
  feature_flags: Record<string, boolean>;
  dataset_versions: Record<string, string>;
  summaries: {
    build: ReturnType<typeof summarizeBuildValidationFixtures>;
    retrieval: ReturnType<typeof summarizeRetrievalResults>;
    runtime: ReturnType<typeof summarizeRuntimeResults>;
    answer: ReturnType<typeof summarizeAnswerResults>;
  };
  gates: ReturnType<typeof evaluateAcceptanceGates>;
  top_failures: string[];
};

const defaultDatasetPaths = {
  retrieval: path.resolve(__dirname, "evals/fixtures/support-seed-retrieval.json"),
  runtime: path.resolve(__dirname, "evals/fixtures/support-runtime-scenarios.json"),
  answer: path.resolve(__dirname, "evals/fixtures/support-golden-answers.json"),
  regression: path.resolve(__dirname, "evals/fixtures/support-regression-replays.json"),
  build: path.resolve(__dirname, "evals/fixtures/support-build-validation.json")
} as const;

const DOCS_COM_REPO_OWNER = "docs";
const DOCS_COM_REPO_NAME = "docs-com";
const DOCS_COM_DEFAULT_BRANCH = "master";

const EVAL_DOCS_COM_FIXTURE_FILES = [
  {
    path: "docs/openapi/api-token.md",
    content: `# API Token

## Reset Token

You can reset the API token access permission from the token management page.
`
  },
  {
    path: "docs/integrations/github-callback.md",
    content: `# GitHub Callback

## Callback 404

如果 GitHub 集成授权后回调页面显示 page not found，请检查 Redirect URI、回调域名以及 baseURL 配置。
`
  },
  {
    path: "docs/onesql/query-language.md",
    content: `# ONESQL Query Language

## ORDER BY

ONESQL supports ORDER BY and GROUP BY clauses.
`
  },
  {
    path: "open-docs/openapi/comments.md",
    content: `# Issue Comment

## Issue Comment

The issue comment API requires the documented scope. Confirm the token scope before retrying.
`
  },
  {
    path: "deploy-docs/troubleshooting/infra/callback-runbook.mdx",
    content: `---
title: "Callback Runbook"
---

# Callback Runbook

Verify Redirect URI and callback domain wiring before retrying.
`
  }
] as const;

const EVAL_RESET_STATEMENTS = [
  "DELETE FROM kb_build_validation_results",
  "DELETE FROM kb_ingest_leases",
  "DELETE FROM kb_publications",
  "DELETE FROM kb_builds",
  "DELETE FROM kb_memory_citations",
  "DELETE FROM kb_citation_units",
  "DELETE FROM kb_openapi_operations",
  "DELETE FROM kb_code_symbols",
  "DELETE FROM kb_config_surfaces",
  "DELETE FROM kb_schema_objects",
  "DELETE FROM kb_test_behaviors",
  "DELETE FROM kb_memory_profiles",
  "DELETE FROM kb_memory_relations",
  "DELETE FROM kb_memory_aliases",
  "DELETE FROM kb_memory_signals",
  "DELETE FROM kb_memory_sources",
  "DELETE FROM kb_memory_entries",
  "DELETE FROM kb_chunks",
  "DELETE FROM kb_documents",
  "DELETE FROM kb_serving_versions",
  "DELETE FROM kb_sync_manifest_items",
  "DELETE FROM kb_sync_run_shards",
  "DELETE FROM kb_sync_runs",
  "DELETE FROM kb_sync_jobs",
  "DELETE FROM kb_sync_checkpoints",
  "DELETE FROM kb_github_webhook_events",
  "DELETE FROM kb_metrics_events",
  "DELETE FROM kb_repo_registrations"
] as const;

type LiveBuildValidationFixtureInput = {
  build: Pick<KbBuild, "id" | "knowledge_space" | "repo_id" | "branch" | "build_version" | "status" | "validation_passed">;
  validationSnapshot: {
    duplicatePaths: number;
    orphanChunks: number;
    crossBuildMemorySources: number;
    missingChunkDocuments: number;
    totalDocuments: number;
    totalChunks: number;
    totalMemoryEntries: number;
  };
  artifactSummary: {
    artifactCountsByFamily: Record<string, number>;
    embeddingSummary: {
      chunkEmbeddings: { total: number; ready: number; missing: number };
      citationEmbeddings: { total: number; ready: number; missing: number };
    };
  };
};

type IsolatedDbEvaluationHarness = {
  knowledgeSpace: KbKnowledgeSpace;
  buildSummary: ReturnType<typeof summarizeBuildValidationFixtures>;
  buildDatasetVersion: string;
  cleanup: () => Promise<void>;
};

function parseArg(flag: string): string | null {
  const match = process.argv.find((item) => item.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

function parseBooleanFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export function resolveEvaluationMode(rawMode: string | null | undefined, nodeEnv: string | undefined): EvaluationMode {
  if (rawMode === "isolated_db" || rawMode === "shared_db_shadow" || rawMode === "production") {
    return rawMode;
  }
  if (nodeEnv === "test") return "isolated_db";
  return "fast_local";
}

function parseMode(): EvaluationMode {
  return resolveEvaluationMode(parseArg("--mode"), process.env.NODE_ENV);
}

function currentGitRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function resetEvaluationKbDb(): Promise<void> {
  for (const statement of EVAL_RESET_STATEMENTS) {
    await pool.query(statement);
  }
}

async function createEvalFixtureRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "support-eval-db-"));
  execFileSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], {
    cwd: rootDir,
    stdio: "ignore"
  });
  return rootDir;
}

async function writeEvalFixture(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export function buildLiveBuildValidationFixtureCase(input: LiveBuildValidationFixtureInput): BuildValidationFixtureCase {
  const chunkEmbeddings = input.artifactSummary.embeddingSummary.chunkEmbeddings;
  const citationEmbeddings = input.artifactSummary.embeddingSummary.citationEmbeddings;
  const embeddingEnabledFamilies = [
    ...(chunkEmbeddings.total > 0 ? ["chunks"] : []),
    ...(citationEmbeddings.total > 0 ? ["citation_units"] : [])
  ];
  const citationCount = input.artifactSummary.artifactCountsByFamily.citation_units ?? 0;
  const memoryEntryCount = input.artifactSummary.artifactCountsByFamily.memory_entries ?? input.validationSnapshot.totalMemoryEntries;

  return {
    id: input.build.id,
    knowledgeSpace: input.build.knowledge_space,
    repoId: input.build.repo_id,
    branch: input.build.branch,
    buildVersion: input.build.build_version,
    buildStatus: input.build.status,
    buildSuccess: input.build.status !== "failed" && input.build.status !== "abandoned",
    validationPassed: input.build.validation_passed,
    duplicateActivePathCount: input.validationSnapshot.duplicatePaths,
    artifactCountsByFamily: input.artifactSummary.artifactCountsByFamily,
    citationCount,
    memoryEntryCount,
    crossBuildReferenceViolationCount:
      input.validationSnapshot.crossBuildMemorySources +
      input.validationSnapshot.orphanChunks +
      input.validationSnapshot.missingChunkDocuments,
    embeddingEnabledFamilies,
    missingEmbeddingCount: chunkEmbeddings.missing + citationEmbeddings.missing,
    previousArtifactCountsByFamily: { ...input.artifactSummary.artifactCountsByFamily },
    previousCitationCount: citationCount,
    previousMemoryEntryCount: memoryEntryCount
  };
}

async function prepareIsolatedDbEvaluationHarness(): Promise<IsolatedDbEvaluationHarness> {
  const readiness = await probeLocalDbReadiness({
    pool,
    databaseUrl: process.env.DATABASE_URL ?? env.DATABASE_URL,
    isSafeTestDatabaseUrl
  });
  if (readiness.kind === "blocked") {
    throw new Error(formatLocalDbBlockedMessage("ai-support-agent.business-eval", readiness));
  }

  const knowledgeSpace = resolveRuntimeKnowledgeSpace();
  const originalMirrorEnabled = env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR;
  const originalLocalDocsPath = env.LOCAL_DOCS_COM_PATH;
  let rootDir = "";
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = originalMirrorEnabled;
    env.LOCAL_DOCS_COM_PATH = originalLocalDocsPath;
    await resetEvaluationKbDb();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  };

  try {
    await resetEvaluationKbDb();
    rootDir = await createEvalFixtureRoot();
    for (const fixture of EVAL_DOCS_COM_FIXTURE_FILES) {
      await writeEvalFixture(rootDir, fixture.path, fixture.content);
    }

    env.GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR = true;
    env.LOCAL_DOCS_COM_PATH = rootDir;

    await ensureDocsComKnowledgeBase({
      actor: "evaluation_harness",
      mode: "full",
      runLimit: 10,
      publicationMode: "publish_inline"
    });

    const registration = await githubRepo.findActiveRepoByOwnerNameBranch(DOCS_COM_REPO_OWNER, DOCS_COM_REPO_NAME, DOCS_COM_DEFAULT_BRANCH);
    if (!registration) {
      throw new Error("Isolated DB evaluation bootstrap did not create the docs-com registration");
    }

    const publication = await githubRepo.getPublication({
      knowledgeSpace,
      repoId: registration.id,
      branch: registration.default_branch
    });
    if (!publication) {
      throw new Error(`Isolated DB evaluation bootstrap did not publish a ${knowledgeSpace} snapshot`);
    }

    const build = await githubRepo.getBuildByVersion({
      knowledgeSpace,
      repoId: registration.id,
      branch: registration.default_branch,
      buildVersion: publication.published_build_version
    });
    if (!build) {
      throw new Error(`Published build ${publication.published_build_version} could not be loaded for isolated DB evaluation`);
    }

    const validationSnapshot = await githubRepo.getBuildValidationSnapshot({
      knowledgeSpace,
      repoId: registration.id,
      branch: registration.default_branch,
      buildVersion: build.build_version
    });
    const artifactSummary = await githubRepo.getBuildArtifactSummary({
      knowledgeSpace,
      repoId: registration.id,
      branch: registration.default_branch,
      buildVersion: build.build_version
    });

    return {
      knowledgeSpace,
      buildSummary: summarizeBuildValidationFixtures([
        buildLiveBuildValidationFixtureCase({
          build,
          validationSnapshot,
          artifactSummary
        })
      ]),
      buildDatasetVersion: `live:${build.build_version}`,
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function startServer() {
  const { app } = await import("../app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve eval server address");
  }
  return { server, port: address.port };
}

async function requestJson<T>(port: number, requestPath: string, body: unknown): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`));
            return;
          }
          resolve(JSON.parse(text) as T);
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(String(value).trim());
  }
  return items;
}

function inferCandidateFamily(hit: RetrievalHit): string {
  const supportMetadata = (hit.supportMetadata ?? {}) as Record<string, unknown>;
  const docMetadata = (hit.docMetadata ?? {}) as Record<string, unknown>;
  const explicit = [
    supportMetadata.evidence_kind,
    supportMetadata.doc_kind,
    supportMetadata.source_family,
    docMetadata.source_family,
    docMetadata.doc_kind
  ]
    .map((item) => String(item ?? "").trim())
    .find(Boolean);
  if (explicit) return explicit;
  if (/openapi|swagger|operation/i.test(hit.path)) return "openapi_spec";
  if (/\.(sql|ddl)$/i.test(hit.path)) return "schema_file";
  if (/\.(ts|tsx|js|jsx|go|py|java|rb|php|rs)$/i.test(hit.path)) return "code_file";
  if (/\.(ya?ml|json|toml)$/i.test(hit.path)) return "config_file";
  if (/test/i.test(hit.path)) return "test_file";
  return "doc_page";
}

function extractExactSignalMatches(hit: RetrievalHit, expectedSignals: string[]): string[] {
  const haystack = normalizeText(
    [
      hit.path,
      hit.title,
      hit.headingPath,
      hit.snippet,
      String(((hit.supportMetadata ?? {}) as Record<string, unknown>).object_type ?? ""),
      String(((hit.supportMetadata ?? {}) as Record<string, unknown>).api_path ?? "")
    ].join(" ")
  );
  return uniqueStrings(expectedSignals.filter((signal) => haystack.includes(normalizeText(signal))));
}

export function mapRetrievalObservation(hitResponse: Awaited<ReturnType<typeof retrieveKnowledge>>, expectedSignals: string[]): RetrievalObservation {
  const publicationScopedRead =
    hitResponse.hits.length > 0 && hitResponse.hits.every((hit) => Boolean((hit.docMetadata ?? {}).build_version));
  const retrievalStatus =
    hitResponse.retrievalStatus ?? (hitResponse.hits.length > 0 ? "grounded" : "no_results");

  return {
    retrievalStatus,
    publicationScopedRead,
    resolvedQueries: hitResponse.resolvedQueries ?? [hitResponse.query],
    candidates: hitResponse.hits.map((hit) => ({
      artifactId: hit.documentId,
      path: hit.path,
      citationTarget: `${hit.path}#${hit.headingPath}`,
      family: inferCandidateFamily(hit),
      groundable: Boolean(hit.sourceUrl || hit.path),
      exactSignalMatches: extractExactSignalMatches(hit, expectedSignals)
    }))
  };
}

function inferSpecialistFamily(payload: SearchResult["result"]): string | null {
  const specialist = payload.internal_diagnostics?.specialists_used?.[0];
  if (specialist) {
    if (specialist.includes("api")) return "api";
    if (specialist.includes("howto")) return "howto";
    if (specialist.includes("behavior")) return "behavior";
    if (specialist.includes("troubleshooting")) return "troubleshooting";
    return specialist;
  }
  const traceAgent = payload.internal_diagnostics?.orchestration_trace?.find((item) => String(item.agent_id ?? "").includes("specialist"))?.agent_id;
  if (!traceAgent) return null;
  if (traceAgent.includes("api")) return "api";
  if (traceAgent.includes("howto")) return "howto";
  if (traceAgent.includes("behavior")) return "behavior";
  if (traceAgent.includes("troubleshooting")) return "troubleshooting";
  return traceAgent;
}

function buildRuntimeObservation(payload: SearchResult["result"]): RuntimeObservation {
  return {
    route: payload.internal_diagnostics?.route?.question_type,
    specialistFamily: inferSpecialistFamily(payload),
    answerMode: payload.support_answer?.mode,
    clarificationNeeded: payload.support_answer?.mode === "clarification" || payload.clarification_round > 0,
    stageTrace: payload.internal_diagnostics?.stage_trace ?? [],
    verificationVerdict: payload.verification?.verdict,
    timeoutStages: [],
    explicitFallbacks: (payload.internal_diagnostics?.stage_trace ?? [])
      .filter((entry) => entry.status === "fallback")
      .map((entry) => entry.stage)
  };
}

function inferAnswerType(payload: SearchResult["result"]): string | null {
  const variant = String(payload.support_answer?.render_variant ?? "").trim();
  if (variant) return variant;
  const route = String(payload.internal_diagnostics?.route?.question_type ?? "").trim();
  if (route.startsWith("api")) return "api";
  if (route === "troubleshooting") return "troubleshooting";
  return payload.support_answer?.mode === "handoff" ? "handoff" : payload.support_answer?.mode === "clarification" ? "clarification" : null;
}

function buildAnswerObservation(payload: SearchResult["result"]): AnswerObservation {
  const claimGraph = payload.internal_diagnostics?.claim_graph ?? [];
  return {
    answerMode: payload.support_answer?.mode,
    answerType: inferAnswerType(payload),
    directAnswer: payload.support_answer?.direct_answer ?? payload.answer ?? "",
    fullAnswerText: [
      payload.support_answer?.direct_answer ?? payload.answer ?? "",
      ...(payload.support_answer?.why ?? []),
      ...(payload.support_answer?.what_to_do_now ?? []),
      ...(payload.support_answer?.still_need_to_confirm ?? [])
    ].join("\n"),
    whatToDoNow: payload.support_answer?.what_to_do_now ?? [],
    stillNeedToConfirm: payload.support_answer?.still_need_to_confirm ?? [],
    citations: payload.citations ?? [],
    verificationVerdict: payload.verification?.verdict,
    unsupportedClaims: claimGraph
      .filter((item) => normalizeText(item.verdict) === "unsupported")
      .map((item) => String(item.text ?? "").trim())
      .filter(Boolean)
  };
}

function extractTopFailures(report: EvalReport): string[] {
  return uniqueStrings([
    ...report.summaries.build.failures,
    ...report.summaries.retrieval.failures,
    ...report.summaries.runtime.failures,
    ...report.summaries.answer.failures,
    ...report.gates.gates.kbBuildGate.reasons,
    ...report.gates.gates.retrievalChangeGate.reasons,
    ...report.gates.gates.runtimeContractGate.reasons,
    ...report.gates.gates.answerQualityGate.reasons,
    ...report.gates.gates.productionEnablementGate.reasons
  ]).slice(0, 25);
}

function buildInfrastructureFailureResult(language: "zh" | "en", error: unknown): SearchResult["result"] {
  const message = error instanceof Error ? error.message : String(error);
  return {
    session_id: crypto.randomUUID(),
    answer: language === "zh" ? "评估运行时无法连接依赖基础设施。" : "The evaluation runner could not reach the required infrastructure.",
    answer_language: language,
    support_answer: {
      mode: "handoff",
      render_variant: "handoff",
      direct_answer:
        language === "zh"
          ? "当前评估环境缺少可用基础设施，无法完成可靠的支持流程回放。"
          : "The current evaluation environment is missing required infrastructure, so a reliable support replay could not complete.",
      why: [],
      what_to_do_now: [
        language === "zh" ? `修复基础设施后重新运行评估：${message}` : `Restore the required infrastructure and rerun the evaluation: ${message}`
      ],
      still_need_to_confirm: []
    },
    verification: {
      verdict: "unsupported"
    },
    citations: [],
    retrieval_status: "kb_unavailable",
    unresolved_reason_code: "KB_RETRIEVAL_UNAVAILABLE",
    clarification_round: 0,
    follow_up_question: null,
    show_create_ticket_now: true,
    internal_diagnostics: {
      stage_trace: []
    }
  };
}

async function loadBaselineReport(baselinePath: string | null): Promise<EvalReport | null> {
  if (!baselinePath) return null;
  const raw = await readFile(path.resolve(baselinePath), "utf8");
  return JSON.parse(raw) as EvalReport;
}

async function main() {
  const mode = parseMode();
  const baselinePath = parseArg("--baseline");
  const outputPath = parseArg("--output");
  const requireBaselineForBehaviorChanges = parseBooleanFlag("--require-baseline");
  const buildDatasetPath = parseArg("--build") ?? defaultDatasetPaths.build;
  const isolatedDbHarness = mode === "isolated_db" ? await prepareIsolatedDbEvaluationHarness() : null;
  const buildDataset = isolatedDbHarness ? null : await loadBuildValidationFixtureDataset(buildDatasetPath);
  const { server, port } = await startServer();
  try {
    const retrievalDataset = await loadRetrievalSeedDataset(parseArg("--retrieval") ?? defaultDatasetPaths.retrieval);
    const runtimeDataset = await loadRuntimeScenarioDataset(parseArg("--runtime") ?? defaultDatasetPaths.runtime);
    const answerDataset = await loadAnswerGoldenDataset(parseArg("--answer") ?? defaultDatasetPaths.answer);
    const regressionDataset = await loadRegressionReplayDataset(parseArg("--regression") ?? defaultDatasetPaths.regression);
    const baseline = await loadBaselineReport(baselinePath);

    const retrievalCases = [
      ...retrievalDataset.cases,
      ...regressionDataset.cases.filter((item) => item.kind === "retrieval").map((item) => item.case)
    ];
    const runtimeCases = [
      ...runtimeDataset.cases,
      ...regressionDataset.cases.filter((item) => item.kind === "runtime").map((item) => item.case)
    ];
    const answerCases = [
      ...answerDataset.cases,
      ...regressionDataset.cases.filter((item) => item.kind === "answer").map((item) => item.case)
    ];

    const retrievalResults = [];
    for (const datasetCase of retrievalCases) {
      const response = await retrieveKnowledge({
        query: datasetCase.query,
        answerLanguage: datasetCase.answerLanguage,
        profile: "agent",
        includeFallback: false
      }).catch(() => ({
        query: datasetCase.query,
        profile: "agent" as const,
        answerLanguage: datasetCase.answerLanguage,
        answer:
          datasetCase.answerLanguage === "zh"
            ? "评估环境当前无法访问知识库。"
            : "The evaluation environment cannot reach the knowledge base right now.",
        resolvedQueries: [datasetCase.query],
        confidence: 0,
        fallbackUsed: false,
        hits: []
      }));
      retrievalResults.push(
        scoreRetrievalCase({
          datasetCase,
          observed: mapRetrievalObservation(response, datasetCase.expectedExactSignals)
        })
      );
    }

    const searchCache = new Map<string, SearchResult["result"]>();
    async function executeSearch(query: string, answerLanguage: "zh" | "en", conversation: Array<{ role: "user" | "assistant"; content: string }>) {
      const cacheKey = crypto
        .createHash("sha256")
        .update(JSON.stringify({ query, answerLanguage, conversation }))
        .digest("hex");
      const cached = searchCache.get(cacheKey);
      if (cached) return cached;
      const response = await requestJson<SearchResult>(port, "/api/v1/ai/search", {
        query,
        answerLanguage,
        conversation,
        sessionId: crypto.randomUUID()
      }).catch((error) => ({ result: buildInfrastructureFailureResult(answerLanguage, error) }));
      searchCache.set(cacheKey, response.result);
      return response.result;
    }

    const runtimeResults = [];
    for (const datasetCase of runtimeCases) {
      const payload = await executeSearch(datasetCase.query, datasetCase.answerLanguage, datasetCase.conversation);
      runtimeResults.push(
        scoreRuntimeScenarioCase({
          datasetCase,
          observed: buildRuntimeObservation(payload)
        })
      );
    }

    const answerResults = [];
    for (const datasetCase of answerCases) {
      const payload = await executeSearch(datasetCase.query, datasetCase.answerLanguage, datasetCase.conversation);
      answerResults.push(
        scoreAnswerCase({
          datasetCase,
          observed: buildAnswerObservation(payload)
        })
      );
    }

    const buildSummary = isolatedDbHarness?.buildSummary ?? summarizeBuildValidationFixtures(buildDataset!.cases);
    const retrievalSummary = summarizeRetrievalResults(retrievalResults);
    const runtimeSummary = summarizeRuntimeResults(runtimeResults);
    const answerSummary = summarizeAnswerResults(answerResults);
    const gates = evaluateAcceptanceGates({
      buildSummary,
      retrievalSummary,
      runtimeSummary,
      answerSummary,
      baseline: baseline
        ? {
            retrievalSummary: baseline.summaries.retrieval,
            runtimeSummary: baseline.summaries.runtime,
            answerSummary: baseline.summaries.answer
          }
        : undefined,
      requireBaselineForBehaviorChanges,
      executionMode: mode,
      shadowValidationStable: parseBooleanFlag("--shadow-stable"),
      rollbackReady: !parseBooleanFlag("--no-rollback-ready"),
      diagnosticsAvailable: true
    });

    const report: EvalReport = {
      generated_at: new Date().toISOString(),
      mode,
      git_revision: currentGitRevision(),
      knowledge_space: isolatedDbHarness?.knowledgeSpace ?? resolveRuntimeKnowledgeSpace(),
      feature_flags: {
        FEATURE_KB_GROUNDED_SEARCH: env.FEATURE_KB_GROUNDED_SEARCH,
        FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: env.FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL,
        FEATURE_AI_MULTI_TURN_HANDOFF: env.FEATURE_AI_MULTI_TURN_HANDOFF
      },
      dataset_versions: {
        retrieval: retrievalDataset.version,
        runtime: runtimeDataset.version,
        answer: answerDataset.version,
        regression: regressionDataset.version,
        build: isolatedDbHarness?.buildDatasetVersion ?? buildDataset!.version
      },
      summaries: {
        build: buildSummary,
        retrieval: retrievalSummary,
        runtime: runtimeSummary,
        answer: answerSummary
      },
      gates,
      top_failures: []
    };
    report.top_failures = extractTopFailures(report);

    if (outputPath) {
      await writeFile(path.resolve(outputPath), JSON.stringify(report, null, 2), "utf8");
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await isolatedDbHarness?.cleanup();
  }
}

const entryFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entryFile === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
