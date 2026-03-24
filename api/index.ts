import { app, ensureAiRuntimeReady } from "../apps/api/src/app.js";

let runtimeReadyPromise: Promise<void> | null = null;

async function ensureRuntimeReadyOnce() {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = ensureAiRuntimeReady().catch((error) => {
      runtimeReadyPromise = null;
      throw error;
    });
  }
  return runtimeReadyPromise;
}

export default async function handler(req: any, res: any) {
  try {
    await ensureRuntimeReadyOnce();
    return app(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vercel API bootstrap failed";
    console.error("[vercel-api] bootstrap failure:", message);
    res.status(503).json({ error: message });
  }
}
