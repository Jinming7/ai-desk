import { WebSocket } from "ws";
import { env } from "../../config/env.js";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput
} from "./types.js";

interface RpcReq {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface RpcRes {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export class WsOpenClawAdapter implements OpenClawAdapter {
  private consecutiveFailures = 0;
  private readonly requestedScopes = env.OPENCLAW_REQUEST_SCOPES.split(",").map((item) => item.trim()).filter(Boolean);

  async healthCheck() {
    try {
      await this.connectOnly();
      return { ok: true, mode: "ws" as const, detail: "Connected to OpenClaw gateway" };
    } catch (error) {
      return { ok: false, mode: "ws" as const, detail: (error as Error).message };
    }
  }

  async analyzeTicket(input: OpenClawAnalyzeInput, idempotencyKey: string): Promise<OpenClawAnalyzeOutput> {
    const result = await this.withRetry(() => this.callMethod("ticket.analyze", { ...input, idempotency_key: idempotencyKey }));
    return result as OpenClawAnalyzeOutput;
  }

  async searchKnowledge(input: OpenClawSearchInput, idempotencyKey: string): Promise<OpenClawSearchOutput> {
    const result = await this.withRetry(() =>
      this.callMethod(
        "kb.search",
        {
          query: input.query,
          top_k: input.topK,
          index: input.index,
          idempotency_key: idempotencyKey
        },
        env.OPENCLAW_SEARCH_TIMEOUT_MS
      )
    );
    return result as OpenClawSearchOutput;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.consecutiveFailures >= env.OPENCLAW_CIRCUIT_BREAKER_THRESHOLD) {
      throw new Error("OpenClaw circuit breaker open");
    }

    for (let attempt = 0; attempt <= env.OPENCLAW_MAX_RETRIES; attempt += 1) {
      try {
        const result = await fn();
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        this.consecutiveFailures += 1;
        if (attempt >= env.OPENCLAW_MAX_RETRIES) {
          throw error;
        }
        const backoff = 2 ** attempt * 300;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw new Error("OpenClaw retry loop exhausted");
  }

  private async callMethod(method: string, params: Record<string, unknown>, timeoutMs = env.OPENCLAW_METHOD_TIMEOUT_MS): Promise<unknown> {
    const authHeader =
      env.OPENCLAW_BASIC_USER && env.OPENCLAW_BASIC_PASS
        ? `Basic ${Buffer.from(`${env.OPENCLAW_BASIC_USER}:${env.OPENCLAW_BASIC_PASS}`).toString("base64")}`
        : undefined;

    const wsOptions = {
      headers: authHeader ? { Authorization: authHeader } : undefined,
      rejectUnauthorized: !env.OPENCLAW_ALLOW_SELF_SIGNED
    };

    const ws = new WebSocket(env.OPENCLAW_WS_URL, wsOptions);

    return await new Promise<unknown>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error("OpenClaw connect timeout"));
        ws.close();
      }, env.OPENCLAW_CONNECT_TIMEOUT_MS);

      let requestTimeout: NodeJS.Timeout | undefined;

      ws.on("open", () => {
        const connectReq: RpcReq = {
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "gateway-client",
              version: "1.0.0",
              platform: "server",
              mode: "backend",
              instanceId: "ticket-core"
            },
            role: "operator",
            scopes: this.requestedScopes,
            caps: [],
            auth: {
              token: env.OPENCLAW_GATEWAY_TOKEN
            },
            userAgent: "ticket-core",
            locale: "en-US"
          }
        };

        ws.send(JSON.stringify(connectReq));
      });

      ws.on("message", (raw) => {
        const data = JSON.parse(String(raw)) as RpcRes | { type: "event"; event: string };

        if (data.type === "event") {
          return;
        }

        if (data.type === "res" && data.id === "connect-1") {
          clearTimeout(connectTimeout);
          if (!data.ok) {
            reject(new Error(`OpenClaw connect failed: ${data.error?.code ?? "UNKNOWN"}`));
            ws.close();
            return;
          }

          const requestId = "method-1";
          const request: RpcReq = {
            type: "req",
            id: requestId,
            method,
            params
          };
          requestTimeout = setTimeout(() => {
            reject(new Error(`OpenClaw ${method} timeout`));
            ws.close();
          }, timeoutMs);
          ws.send(JSON.stringify(request));
          return;
        }

        if (data.type === "res" && data.id === "method-1") {
          if (requestTimeout) {
            clearTimeout(requestTimeout);
          }
          ws.close();
          if (!data.ok) {
            reject(new Error(`OpenClaw ${method} failed: ${data.error?.message ?? "UNKNOWN"}`));
            return;
          }
          resolve(data.result);
        }
      });

      ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        reject(error);
      });

      ws.on("close", () => {
        clearTimeout(connectTimeout);
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
      });

      if (!env.OPENCLAW_GATEWAY_TOKEN) {
        reject(new Error("OPENCLAW_GATEWAY_TOKEN is not configured"));
        ws.close();
      }
    });
  }

  private async connectOnly(): Promise<void> {
    const authHeader =
      env.OPENCLAW_BASIC_USER && env.OPENCLAW_BASIC_PASS
        ? `Basic ${Buffer.from(`${env.OPENCLAW_BASIC_USER}:${env.OPENCLAW_BASIC_PASS}`).toString("base64")}`
        : undefined;

    const ws = new WebSocket(env.OPENCLAW_WS_URL, {
      headers: authHeader ? { Authorization: authHeader } : undefined,
      rejectUnauthorized: !env.OPENCLAW_ALLOW_SELF_SIGNED
    });

    return await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("OpenClaw health connect timeout"));
        ws.close();
      }, env.OPENCLAW_CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        const connectReq: RpcReq = {
          type: "req",
          id: "health-connect",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "gateway-client",
              version: "1.0.0",
              platform: "server",
              mode: "backend",
              instanceId: "ticket-core-health"
            },
            role: "operator",
            scopes: this.requestedScopes,
            caps: [],
            auth: {
              token: env.OPENCLAW_GATEWAY_TOKEN
            },
            userAgent: "ticket-core-health",
            locale: "en-US"
          }
        };
        ws.send(JSON.stringify(connectReq));
      });

      ws.on("message", (raw) => {
        const data = JSON.parse(String(raw)) as RpcRes | { type: "event"; event: string };
        if (data.type === "event") return;
        if (data.type === "res" && data.id === "health-connect") {
          clearTimeout(timeout);
          if (!data.ok) {
            reject(new Error(`OpenClaw health connect failed: ${data.error?.code ?? "UNKNOWN"}`));
            ws.close();
            return;
          }
          ws.close();
          resolve();
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ws.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }
}
