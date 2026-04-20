import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

function parseArg(flag) {
  const prefix = `${flag}=`;
  const raw = process.argv.find((item) => item.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function readEnv(filePath) {
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, idx)] = value;
  }
  return out;
}

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function createRpc(env) {
  return async function call(method, params = {}, timeoutMs = 15000) {
    const authHeader =
      env.OPENCLAW_BASIC_USER && env.OPENCLAW_BASIC_PASS
        ? `Basic ${Buffer.from(`${env.OPENCLAW_BASIC_USER}:${env.OPENCLAW_BASIC_PASS}`).toString("base64")}`
        : undefined;
    const headers = {};
    if (authHeader) headers.Authorization = authHeader;
    headers.Origin = env.OPENCLAW_CLIENT_ORIGIN || "https://47.250.122.37";

    const ws = new WebSocket(env.OPENCLAW_WS_URL, {
      headers,
      rejectUnauthorized: env.OPENCLAW_ALLOW_SELF_SIGNED !== "true"
    });

    return await new Promise((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error("connect timeout"));
        ws.close();
      }, Math.min(10000, timeoutMs));

      let methodTimeout;

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
                instanceId: `${env.OPENCLAW_CLIENT_INSTANCE_ID || "ticket-core"}-gateway-repair`
              },
              role: "operator",
              scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
              caps: [],
              auth: {
                token: env.OPENCLAW_GATEWAY_TOKEN,
                password: env.OPENCLAW_BASIC_PASS
              },
              userAgent: "ticket-core-gateway-repair",
              locale: "en-US"
            }
          })
        );
      });

      ws.on("message", (raw) => {
        const data = JSON.parse(String(raw));
        if (data.type === "event") return;

        if (data.type === "res" && data.id === "connect-1") {
          clearTimeout(connectTimeout);
          if (!data.ok) {
            reject(new Error(`connect failed: ${data.error?.message || data.error?.code || "UNKNOWN"}`));
            ws.close();
            return;
          }
          methodTimeout = setTimeout(() => {
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
          if (methodTimeout) clearTimeout(methodTimeout);
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
        if (methodTimeout) clearTimeout(methodTimeout);
        reject(error);
      });
    });
  };
}

function buildSupportAgentSet(config) {
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  return dedupe(
    list
      .map((item) => String(item?.id ?? "").trim())
      .filter((id) => id === "support-main" || id.startsWith("support-"))
  );
}

function patchConfigWithModel(config, modelRef) {
  const next = structuredClone(config);
  if (!next.agents) next.agents = {};
  if (!next.agents.defaults) next.agents.defaults = {};
  if (!next.agents.defaults.model) next.agents.defaults.model = {};
  if (!next.agents.defaults.models) next.agents.defaults.models = {};

  next.agents.defaults.model.primary = modelRef;
  next.agents.defaults.model.fallbacks = [];

  if (!next.agents.defaults.models[modelRef]) {
    next.agents.defaults.models[modelRef] = {};
  }

  const supportAgents = buildSupportAgentSet(next);
  const list = Array.isArray(next.agents.list) ? next.agents.list : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (supportAgents.includes(String(item.id ?? ""))) {
      item.model = modelRef;
    }
  }

  return { config: next, supportAgents };
}

function buildModelCandidates(config, modelsListPayload) {
  const defaults = config?.agents?.defaults ?? {};
  const defaultModel = defaults.model ?? {};
  const explicitRefs = [
    defaultModel.primary,
    ...(Array.isArray(defaultModel.fallbacks) ? defaultModel.fallbacks : []),
    ...Object.keys(defaults.models ?? {})
  ];

  const providerRefs = [];
  const providers = config?.models?.providers ?? {};
  for (const [provider, payload] of Object.entries(providers)) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    for (const model of models) {
      const id = String(model?.id ?? "").trim();
      if (id) providerRefs.push(`${provider}/${id}`);
    }
  }

  const compactRefs = dedupe([...explicitRefs, ...providerRefs]).filter((ref) => ref.includes("/"));
  const availableIds = new Set(
    (Array.isArray(modelsListPayload?.models) ? modelsListPayload.models : [])
      .map((m) => String(m?.id ?? "").trim())
      .filter(Boolean)
  );

  return compactRefs.filter((ref) => {
    const slash = ref.indexOf("/");
    return slash > 0 ? availableIds.has(ref.slice(slash + 1)) : false;
  });
}

async function probeSupportPlanner(callRpc, modelRef) {
  const sessionKey = `agent:support-planner:gateway-repair:${crypto.randomUUID()}`;
  const idempotencyKey = `gateway-repair:${crypto.randomUUID()}`;
  const run = await callRpc(
    "agent",
    {
      agentId: "support-planner",
      sessionKey,
      message: "仅回复 ok",
      timeout: 16000,
      idempotencyKey
    },
    18000
  );

  if (!run?.runId) {
    return { ok: false, error: "agent run did not return runId", modelRef };
  }

  try {
    await callRpc("agent.wait", { runId: run.runId, timeoutMs: 16000 }, 18000);
  } catch {}

  const history = await callRpc("chat.history", { sessionKey, limit: 5 }, 12000);
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (typeof msg.errorMessage === "string" && msg.errorMessage.trim()) {
      return { ok: false, error: msg.errorMessage.trim(), modelRef };
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) {
      return { ok: true, text: text.slice(0, 120), modelRef };
    }
  }
  return { ok: false, error: "no assistant text", modelRef };
}

function writeBackup(configPayload) {
  const dir = path.resolve(process.cwd(), ".tmp");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const fullPath = path.join(dir, `openclaw-gateway-repair-backup-${stamp}.json`);
  fs.writeFileSync(fullPath, JSON.stringify(configPayload, null, 2), "utf8");
  return fullPath;
}

async function main() {
  const envPath = parseArg("--env-file") || path.resolve("/Users/jeremypeng/Downloads/Workspace/TicketManagement/.env");
  const env = readEnv(envPath);
  const callRpc = createRpc(env);

  const configPayload = await callRpc("config.get", {}, 15000);
  const baseHash = String(configPayload?.hash ?? "");
  const currentConfig = configPayload?.config;
  if (!baseHash || !currentConfig) {
    throw new Error("config.get did not return hash/config");
  }

  const backupPath = writeBackup(configPayload);
  console.log(JSON.stringify({ stage: "backup", backupPath }, null, 2));

  const modelsPayload = await callRpc("models.list", {}, 15000);
  const candidates = buildModelCandidates(currentConfig, modelsPayload);
  console.log(JSON.stringify({ stage: "candidates", count: candidates.length, candidates }, null, 2));

  let workingModel = null;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const latestConfigPayload = await callRpc("config.get", {}, 15000);
      const latestHash = String(latestConfigPayload?.hash ?? "");
      const latestConfig = latestConfigPayload?.config;
      if (!latestHash || !latestConfig) {
        throw new Error("config.get before set did not return hash/config");
      }
      const patched = patchConfigWithModel(latestConfig, candidate);
      const setRes = await callRpc(
        "config.set",
        {
          baseHash: latestHash,
          raw: `${JSON.stringify(patched.config, null, 2)}\n`
        },
        20000
      );
      if (setRes?.hash && String(setRes.hash).trim()) {
        // keep call for side effects; hash is not required for next loop
      }

      const probe = await probeSupportPlanner(callRpc, candidate);
      console.log(JSON.stringify({ stage: "probe", candidate, probe }, null, 2));
      if (probe.ok) {
        workingModel = candidate;
        break;
      }
      lastError = probe.error || "unknown probe failure";
    } catch (error) {
      lastError = String(error);
      console.log(JSON.stringify({ stage: "probe-error", candidate, error: String(error) }, null, 2));
    }
  }

  if (!workingModel) {
    try {
      const latest = await callRpc("config.get", {}, 15000);
      const rollbackHash = String(latest?.hash ?? "");
      if (rollbackHash) {
        await callRpc("config.set", { baseHash: rollbackHash, raw: `${JSON.stringify(currentConfig, null, 2)}\n` }, 20000);
      }
    } catch {}
    throw new Error(`no working model found for support planner; rolled back. last_error=${lastError ?? "unknown"}`);
  }

  console.log(JSON.stringify({ stage: "done", workingModel }, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
