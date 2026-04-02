import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 15000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? 15000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? 12000),
  keepAlive: true
});
