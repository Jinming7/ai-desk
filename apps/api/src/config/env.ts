import { config } from "dotenv";
import path from "node:path";
import { z } from "zod";

const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";

config({ path: path.resolve(process.cwd(), envFile) });
config({ path: path.resolve(process.cwd(), "../../", envFile), override: false });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  OPENCLAW_WS_URL: z.string().default("wss://47.250.122.37/"),
  OPENCLAW_BASIC_USER: z.string().optional(),
  OPENCLAW_BASIC_PASS: z.string().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_SEARCH_INDEX: z.string().default("public_kb"),
  OPENCLAW_CONNECT_TIMEOUT_MS: z.coerce.number().default(10000),
  OPENCLAW_METHOD_TIMEOUT_MS: z.coerce.number().default(30000),
  OPENCLAW_SEARCH_TIMEOUT_MS: z.coerce.number().default(12000),
  OPENCLAW_MAX_RETRIES: z.coerce.number().default(2),
  OPENCLAW_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5),
  OPENCLAW_SEARCH_TOP_K: z.coerce.number().default(5),
  OPENCLAW_DEEP_SEARCH_MAX_ROUNDS: z.coerce.number().default(3),
  AI_SEARCH_ANSWER_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.62),
  AGENT_RESOLUTION_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.76),
  FEATURE_KB_GROUNDED_SEARCH: z.coerce.boolean().default(true),
  FEATURE_QUICK_TICKET: z.coerce.boolean().default(true),
  FEATURE_DEEP_RETRIEVAL: z.coerce.boolean().default(true)
});

export const env = envSchema.parse(process.env);
