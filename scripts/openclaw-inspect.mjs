import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

function readEnv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

function connectAndCall(
  env,
  method,
  params = {},
  timeoutMs = Number(env.OPENCLAW_METHOD_TIMEOUT_MS || 10000),
  connectOverrides = {}
) {
  const authHeader =
    env.OPENCLAW_BASIC_USER && env.OPENCLAW_BASIC_PASS
      ? `Basic ${Buffer.from(`${env.OPENCLAW_BASIC_USER}:${env.OPENCLAW_BASIC_PASS}`).toString("base64")}`
      : undefined;

  const headers = {};
  if (authHeader) headers.Authorization = authHeader;
  if (env.OPENCLAW_CLIENT_ORIGIN) headers.Origin = env.OPENCLAW_CLIENT_ORIGIN;

  const ws = new WebSocket(env.OPENCLAW_WS_URL, {
    headers: Object.keys(headers).length ? headers : undefined,
    rejectUnauthorized: env.OPENCLAW_ALLOW_SELF_SIGNED !== "true"
  });

  return new Promise((resolve, reject) => {
    const connectTimeout = setTimeout(() => {
      reject(new Error("connect timeout"));
      ws.close();
    }, Number(env.OPENCLAW_CONNECT_TIMEOUT_MS || 10000));

    let requestTimeout;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "openclaw-control-ui",
              version: "1.0.0",
              platform: "server",
              mode: "backend",
              instanceId: `${env.OPENCLAW_CLIENT_INSTANCE_ID || "ticket-core"}-inspect`
            },
            role: "operator",
            scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
            caps: [],
            auth: {
              token: env.OPENCLAW_GATEWAY_TOKEN,
              password: env.OPENCLAW_BASIC_PASS
            },
            userAgent: "ticket-core-inspect",
            locale: "en-US",
            ...connectOverrides,
            client: {
              id: "openclaw-control-ui",
              version: "1.0.0",
              platform: "server",
              mode: "backend",
              instanceId: `${env.OPENCLAW_CLIENT_INSTANCE_ID || "ticket-core"}-inspect`,
              ...(connectOverrides.client || {})
            },
            auth: {
              token: env.OPENCLAW_GATEWAY_TOKEN,
              password: env.OPENCLAW_BASIC_PASS,
              ...(connectOverrides.auth || {})
            }
          }
        })
      );
    });

    ws.on("message", (raw) => {
      const data = JSON.parse(String(raw));
      if (data.type === "event") {
        console.error(JSON.stringify({ event: data.event, payload: data.payload ?? null }));
        return;
      }
      if (data.type === "res" && data.id === "connect-1") {
        clearTimeout(connectTimeout);
        if (!data.ok) {
          reject(new Error(`connect failed: ${data.error?.code || data.error?.message || "UNKNOWN"}`));
          ws.close();
          return;
        }
        requestTimeout = setTimeout(() => {
          reject(new Error(`${method} timeout`));
          ws.close();
        }, timeoutMs);
        ws.send(
          JSON.stringify({
            type: "req",
            id: "method-1",
            method,
            params
          })
        );
        return;
      }
      if (data.type === "res" && data.id === "method-1") {
        if (requestTimeout) clearTimeout(requestTimeout);
        ws.close();
        if (!data.ok) {
          reject(new Error(`${method} failed: ${data.error?.message || data.error?.code || "UNKNOWN"}`));
          return;
        }
        resolve(data.payload ?? data.result ?? null);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(connectTimeout);
      if (requestTimeout) clearTimeout(requestTimeout);
      reject(error);
    });

    ws.on("close", () => {
      clearTimeout(connectTimeout);
      if (requestTimeout) clearTimeout(requestTimeout);
    });
  });
}

async function main() {
  const envPath = path.resolve(process.cwd(), ".env");
  const env = readEnv(envPath);
  const variants = [
    {
      name: "backend-control-ui",
      overrides: {}
    },
    {
      name: "webchat-control-ui",
      overrides: {
        client: {
          id: "openclaw-control-ui",
          version: "vdev",
          platform: "MacIntel",
          mode: "webchat",
          instanceId: `${env.OPENCLAW_CLIENT_INSTANCE_ID || "ticket-core"}-inspect`
        }
      }
    }
  ];
  const methods = [
    ["whoami", {}],
    ["agent.list", {}],
    ["agents.list", {}],
    ["registry.list", {}],
    ["chat.history", { sessionKey: env.OPENCLAW_AGENT_SESSION_KEY || "agent:main:main", limit: 1 }]
  ];

  for (const variant of variants) {
    for (const [method, params] of methods) {
      try {
        const result = await connectAndCall(env, method, params, undefined, variant.overrides);
        console.log(JSON.stringify({ variant: variant.name, method, ok: true, result }, null, 2));
      } catch (error) {
        console.log(JSON.stringify({ variant: variant.name, method, ok: false, error: String(error) }, null, 2));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
