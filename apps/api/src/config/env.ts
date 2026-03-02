import { config } from "dotenv";
import { z } from "zod";

config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  OPENCLAW_WS_URL: z.string().default("wss://47.250.122.37/"),
  OPENCLAW_BASIC_USER: z.string().optional(),
  OPENCLAW_BASIC_PASS: z.string().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_CONNECT_TIMEOUT_MS: z.coerce.number().default(10000),
  OPENCLAW_METHOD_TIMEOUT_MS: z.coerce.number().default(30000),
  OPENCLAW_MAX_RETRIES: z.coerce.number().default(2),
  OPENCLAW_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5)
});

export const env = envSchema.parse(process.env);
