const baseUrl = String(process.env.KB_AUTOMATION_BASE_URL ?? "").replace(/\/$/, "");
const token = String(process.env.INTERNAL_OPS_TOKEN ?? "").trim();
const mode = String(process.env.KB_ENSURE_MODE ?? "incremental").trim();
const runLimit = Number(process.env.KB_ENSURE_RUN_LIMIT ?? 4);
const maxAttempts = Number(process.env.KB_ENSURE_MAX_ATTEMPTS ?? 20);
const waitMs = Number(process.env.KB_ENSURE_WAIT_MS ?? 15000);

if (!baseUrl || !token) {
  console.log("[kb-ensure] skipped: KB_AUTOMATION_BASE_URL or INTERNAL_OPS_TOKEN is missing");
  process.exit(0);
}

const ensureUrl = `${baseUrl}/api/v1/internal/kb/docs-com/ensure`;
const statusUrl = `${baseUrl}/api/v1/internal/kb/docs-com/status?limit=8`;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

let lastError = "unknown";
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = await request(ensureUrl, {
    method: "POST",
    body: JSON.stringify({
      mode,
      actor: "github_actions",
      runLimit
    })
  }).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  });

  if (result?.response.ok) {
    console.log(`[kb-ensure] ensure accepted on attempt ${attempt}`);
    console.log(JSON.stringify(result.json ?? { raw: result.text }, null, 2));

    const status = await request(statusUrl, { method: "GET" }).catch((error) => ({
      response: { ok: false, status: 0 },
      text: error instanceof Error ? error.message : String(error),
      json: null
    }));
    console.log("[kb-ensure] status snapshot:");
    console.log(JSON.stringify(status.json ?? { raw: status.text }, null, 2));
    process.exit(0);
  }

  lastError = result ? `${result.response.status} ${result.text}` : lastError;
  console.log(`[kb-ensure] attempt ${attempt}/${maxAttempts} not ready: ${lastError}`);
  if (attempt < maxAttempts) {
    await sleep(waitMs);
  }
}

console.error(`[kb-ensure] failed after ${maxAttempts} attempts: ${lastError}`);
process.exit(1);
