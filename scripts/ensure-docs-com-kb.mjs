const baseUrl = String(process.env.KB_AUTOMATION_BASE_URL ?? "").replace(/\/$/, "");
const token = String(process.env.INTERNAL_OPS_TOKEN ?? "").trim();
const mode = String(process.env.KB_ENSURE_MODE ?? "incremental").trim();
const runLimit = Number(process.env.KB_ENSURE_RUN_LIMIT ?? 0);
const maxAttempts = Number(process.env.KB_ENSURE_MAX_ATTEMPTS ?? 20);
const waitMs = Number(process.env.KB_ENSURE_WAIT_MS ?? 15000);

if (!baseUrl || !token) {
  console.log("[kb-ensure] skipped: KB_AUTOMATION_BASE_URL or INTERNAL_OPS_TOKEN is missing");
  process.exit(0);
}

const ensureUrl = `${baseUrl}/api/v1/internal/kb/docs-com/ensure`;
const statusUrl = `${baseUrl}/api/v1/internal/kb/docs-com/status?limit=8`;
const runUrl = `${baseUrl}/api/v1/internal/kb/sync/run`;

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

const ensureResult = await request(ensureUrl, {
  method: "POST",
  body: JSON.stringify({
    mode,
    actor: "github_actions",
    runLimit
  })
}).catch((error) => ({
  response: { ok: false, status: 0 },
  text: error instanceof Error ? error.message : String(error),
  json: null
}));

if (!ensureResult.response.ok) {
  console.error(`[kb-ensure] ensure failed: ${ensureResult.response.status} ${ensureResult.text}`);
  process.exit(1);
}

console.log("[kb-ensure] ensure accepted");
console.log(JSON.stringify(ensureResult.json ?? { raw: ensureResult.text }, null, 2));

let lastError = "unknown";
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const run = await request(runUrl, {
    method: "POST",
    body: JSON.stringify({ limit: 1 })
  }).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  });
  if (run?.response.ok) {
    console.log(`[kb-ensure] drain attempt ${attempt}`);
    console.log(JSON.stringify(run.json ?? { raw: run.text }, null, 2));
  } else if (run) {
    lastError = `${run.response.status} ${run.text}`;
    console.log(`[kb-ensure] drain attempt ${attempt} failed: ${lastError}`);
  }

  const status = await request(statusUrl, { method: "GET" }).catch((error) => ({
    response: { ok: false, status: 0 },
    text: error instanceof Error ? error.message : String(error),
    json: null
  }));
  if (status.response.ok) {
    const payload = status.json?.result ?? null;
    console.log("[kb-ensure] status snapshot:");
    console.log(JSON.stringify(payload ?? { raw: status.text }, null, 2));
    if (payload?.exists && payload?.status?.health?.ok) {
      process.exit(0);
    }
  } else {
    lastError = `${status.response.status} ${status.text}`;
  }

  if (attempt < maxAttempts) {
    await sleep(waitMs);
  }
}

console.error(`[kb-ensure] failed after ${maxAttempts} attempts: ${lastError}`);
process.exit(1);
