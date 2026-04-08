import path from "node:path";
import { z } from "zod";
import { loadDotenvFiles } from "./dotenv-loader.js";
import { envBoolean } from "./env-boolean.js";

const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
const SAFE_TEST_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

loadDotenvFiles({ cwd: process.cwd(), envFile });

function parseDatabaseHostname(url: string): string | null {
  const value = url.trim();
  if (!value) return null;
  try {
    const normalized = value.replace(/^postgres(ql)?:\/\//i, "http://");
    return new URL(normalized).hostname || null;
  } catch {
    return null;
  }
}

export function isSafeTestDatabaseUrl(url: string | null | undefined): boolean {
  const hostname = parseDatabaseHostname(String(url ?? ""));
  return hostname ? SAFE_TEST_DATABASE_HOSTS.has(hostname.toLowerCase()) : false;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  OPENCLAW_WS_URL: z.string().default("wss://47.250.122.37/"),
  OPENCLAW_BASIC_USER: z.string().optional(),
  OPENCLAW_BASIC_PASS: z.string().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_DEVICE_TOKEN: z.string().optional(),
  OPENCLAW_DEVICE_IDENTITY_JSON: z.string().optional(),
  OPENCLAW_DEVICE_IDENTITY_PATH: z.string().optional(),
  OPENCLAW_DEVICE_AUTH_PATH: z.string().optional(),
  OPENCLAW_REQUEST_SCOPES: z.string().default("operator.admin"),
  OPENCLAW_CLIENT_ID: z.string().default("gateway-client"),
  OPENCLAW_CLIENT_MODE: z.string().default("backend"),
  OPENCLAW_CLIENT_PLATFORM: z.string().default("server"),
  OPENCLAW_CLIENT_VERSION: z.string().default("vdev"),
  OPENCLAW_CLIENT_INSTANCE_ID: z.string().default("ticket-core"),
  OPENCLAW_CLIENT_ORIGIN: z.string().default(""),
  OPENCLAW_AGENT_ID: z.string().default("main"),
  OPENCLAW_AGENT_SESSION_KEY: z.string().default("agent:main:main"),
  OPENCLAW_AGENT_MODEL: z.string().default(""),
  OPENCLAW_AGENT_ID_RETRIEVAL: z.string().default(""),
  OPENCLAW_AGENT_ID_CLARIFY: z.string().default(""),
  OPENCLAW_AGENT_ID_EXECUTION: z.string().default("execution"),
  OPENCLAW_AGENT_ID_SUPPORT_MAIN: z.string().default(""),
  OPENCLAW_AGENT_ID_ROUTER: z.string().default(""),
  OPENCLAW_AGENT_ID_EVIDENCE_PLANNER: z.string().default(""),
  OPENCLAW_AGENT_ID_PLANNER: z.string().default(""),
  OPENCLAW_AGENT_ID_SUPPORT_EVIDENCE_SELECTOR: z.string().default(""),
  OPENCLAW_AGENT_ID_API_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_ID_HOWTO_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_ID_BEHAVIOR_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_ID_TROUBLESHOOTING_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_ID_EVIDENCE_JUDGE: z.string().default(""),
  OPENCLAW_AGENT_ID_SUPPORT_CITATION_BINDER: z.string().default(""),
  OPENCLAW_AGENT_ID_CITATION_CURATOR: z.string().default(""),
  OPENCLAW_AGENT_ID_SUPPORT_CITATION_SELECTOR: z.string().default(""),
  OPENCLAW_AGENT_ID_ANSWER_COMPOSER: z.string().default(""),
  OPENCLAW_AGENT_MODEL_RETRIEVAL: z.string().default(""),
  OPENCLAW_AGENT_MODEL_CLARIFY: z.string().default(""),
  OPENCLAW_AGENT_MODEL_EXECUTION: z.string().default(""),
  OPENCLAW_AGENT_MODEL_SUPPORT_MAIN: z.string().default(""),
  OPENCLAW_AGENT_MODEL_ROUTER: z.string().default(""),
  OPENCLAW_AGENT_MODEL_EVIDENCE_PLANNER: z.string().default(""),
  OPENCLAW_AGENT_MODEL_PLANNER: z.string().default(""),
  OPENCLAW_AGENT_MODEL_SUPPORT_EVIDENCE_SELECTOR: z.string().default(""),
  OPENCLAW_AGENT_MODEL_API_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_MODEL_HOWTO_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_MODEL_BEHAVIOR_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_MODEL_TROUBLESHOOTING_SPECIALIST: z.string().default(""),
  OPENCLAW_AGENT_MODEL_EVIDENCE_JUDGE: z.string().default(""),
  OPENCLAW_AGENT_MODEL_SUPPORT_CITATION_BINDER: z.string().default(""),
  OPENCLAW_AGENT_MODEL_CITATION_CURATOR: z.string().default(""),
  OPENCLAW_AGENT_MODEL_SUPPORT_CITATION_SELECTOR: z.string().default(""),
  OPENCLAW_AGENT_MODEL_ANSWER_COMPOSER: z.string().default(""),
  OPENCLAW_AGENT_SESSION_PREFIX: z.string().default("nf"),
  OPENCLAW_RUN_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(900),
  OPENCLAW_RUN_SESSION_REGISTRY_MAX: z.coerce.number().int().min(100).max(10000).default(2000),
  OPENCLAW_DEBUG_STAGE_TIMINGS: envBoolean(false),
  OPENCLAW_AGENT_TIMEOUT_MS: z.coerce.number().default(30000),
  OPENCLAW_ALLOW_SELF_SIGNED: envBoolean(false),
  OPENCLAW_SEARCH_INDEX: z.string().default("public_kb"),
  OPENCLAW_CONNECT_TIMEOUT_MS: z.coerce.number().default(10000),
  OPENCLAW_METHOD_TIMEOUT_MS: z.coerce.number().default(30000),
  OPENCLAW_SEARCH_TIMEOUT_MS: z.coerce.number().default(12000),
  OPENCLAW_MAX_RETRIES: z.coerce.number().default(2),
  OPENCLAW_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5),
  OPENCLAW_SEARCH_TOP_K: z.coerce.number().default(5),
  OPENCLAW_DEEP_SEARCH_MAX_ROUNDS: z.coerce.number().default(3),
  AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.35),
  AGENT_RESOLUTION_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.76),
  DISABLE_AI_TRIAGE_FALLBACK: envBoolean(true),
  FEATURE_KB_GROUNDED_SEARCH: envBoolean(true),
  FEATURE_QUICK_TICKET: envBoolean(true),
  FEATURE_DEEP_RETRIEVAL: envBoolean(true),
  FEATURE_AI_MULTI_TURN_HANDOFF: envBoolean(true),
  FEATURE_KB_MEMORY_GRAPH: envBoolean(true),
  FEATURE_KB_MEMORY_QUERY_REWRITE: envBoolean(true),
  FEATURE_KB_MEMORY_RELATION_EXPANSION: envBoolean(true),
  FEATURE_KB_MEMORY_PROFILES: envBoolean(true),
  FEATURE_SUPPORT_AGENT_HYBRID_RETRIEVAL: envBoolean(true),
  FEATURE_SUPPORT_AGENT_SINGLE_AGENT_RUNTIME: envBoolean(false),
  FEATURE_SUPPORT_AGENT_RUNTIME_TIGHTENING: envBoolean(false),
  AI_SUPPORT_INTERACTIVE_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(22000),
  AI_SUPPORT_JOB_TIMEOUT_MS: z.coerce.number().int().min(10000).max(300000).default(240000),
  AI_SUPPORT_JOB_LEASE_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  AI_SUPPORT_JOB_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(60000).default(3000),
  AI_SUPPORT_JOB_STREAM_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(5000).default(250),
  AI_SUPPORT_JOB_STREAM_MAX_WAIT_MS: z.coerce.number().int().min(1000).max(300000).default(250000),
  AI_SEARCH_MAX_CLARIFICATION_ROUNDS: z.coerce.number().int().min(1).max(10).default(3),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_BASE: z.string().default("https://api.openai.com/v1"),
  OPENAI_MULTIMODAL_MODEL: z.string().default(""),
  OPENAI_CODEX_AUTH_PROFILE_PATH: z.string().optional(),
  OPENAI_MULTIMODAL_MAX_IMAGES: z.coerce.number().int().min(1).max(8).default(4),
  ONES_SYNC_ENCRYPTION_KEY: z.string().default("dev-only-change-me-32-char-key"),
  ONES_SYNC_DEFAULT_BASE_URL: z.string().default("https://ones.com"),
  ONES_SYNC_DEFAULT_PROJECTS_PATH: z.string().default("/project/projects"),
  ONES_SYNC_DEFAULT_TICKET_TYPES_PATH: z.string().default("/project/issueTypes"),
  ONES_SYNC_DEFAULT_FIELDS_PATH_TEMPLATE: z.string().default("/project/issueFields"),
  ONES_SYNC_DEFAULT_CREATE_TICKET_PATH: z.string().default("/project/issues"),
  GITHUB_KB_ENABLED: envBoolean(false),
  INTERNAL_OPS_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  GITHUB_API_BASE_URL: z.string().default("https://api.github.com"),
  GITHUB_TOKEN_READONLY: z.string().optional(),
  GITLAB_API_BASE_URL: z.string().default("https://git.ones.pro/api/v4"),
  GITLAB_TOKEN_READONLY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_KB_ALLOW_BROAD_SCOPES: envBoolean(false),
  GITHUB_KB_BOOTSTRAP_REPO_URL: z.string().optional(),
  GITHUB_KB_BOOTSTRAP_PUBLIC_BASE_URL: z.string().url().optional(),
  GITHUB_KB_BOOTSTRAP_BRANCH: z.string().default("main"),
  GITHUB_KB_BOOTSTRAP_INCLUDE_PATHS: z.string().default("**/*.md,**/*.mdx"),
  GITHUB_KB_BOOTSTRAP_EXCLUDE_PATHS: z
    .string()
    .default(".claude/**,.github/**,.docusaurus/**,node_modules/**,build/**,dist/**"),
  GITHUB_KB_BOOTSTRAP_POLLING_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
  GITHUB_KB_CHUNK_TARGET_TOKENS: z.coerce.number().int().min(100).max(3000).default(500),
  GITHUB_KB_CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(500).default(60),
  GITHUB_KB_VECTOR_DIM: z.coerce.number().int().min(64).max(4096).default(1536),
  GITHUB_KB_EMBEDDING_PROVIDER: z.enum(["mock", "openai", "custom"]).default("mock"),
  GITHUB_KB_EMBEDDING_API_BASE: z.string().default("https://api.openai.com/v1"),
  GITHUB_KB_EMBEDDING_API_KEY: z.string().optional(),
  GITHUB_KB_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  GITHUB_KB_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  GITHUB_KB_EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  GITHUB_KB_PROFILE_SEARCH_TOPK: z.coerce.number().int().min(1).max(30).default(5),
  GITHUB_KB_PROFILE_AGENT_TOPK: z.coerce.number().int().min(1).max(30).default(12),
  GITHUB_KB_PROFILE_SEARCH_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  GITHUB_KB_PROFILE_AGENT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
  GITHUB_KB_POLL_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(5),
  GITHUB_KB_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(2),
  GITHUB_KB_WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  GITHUB_KB_LOCAL_MIRROR_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(5),
  GITHUB_KB_REMOTE_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(8),
  GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR: envBoolean(false),
  LOCAL_DOCS_COM_PATH: z.string().default("/tmp/docs-com"),
  LOCAL_DOCS_CACHE_TTL_SECONDS: z.coerce.number().int().min(10).max(86400).default(300)
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === "test" && !isSafeTestDatabaseUrl(env.DATABASE_URL)) {
  const host = parseDatabaseHostname(env.DATABASE_URL) ?? "<unknown>";
  throw new Error(`Refusing to run NODE_ENV=test against non-local database host: ${host}`);
}
