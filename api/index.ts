type LoadedApp = {
  app: (req: any, res: any) => unknown;
  ensureAiRuntimeReady: () => Promise<void>;
};

let loadedAppPromise: Promise<LoadedApp> | null = null;
let runtimeReadyPromise: Promise<void> | null = null;

async function loadAppModule(): Promise<LoadedApp> {
  if (!loadedAppPromise) {
    loadedAppPromise = import("../apps/api/dist/app.js").then((mod) => ({
      app: mod.app,
      ensureAiRuntimeReady: mod.ensureAiRuntimeReady
    }));
  }
  return loadedAppPromise;
}

async function ensureRuntimeReadyOnce() {
  const mod = await loadAppModule();
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = mod.ensureAiRuntimeReady().catch((error) => {
      runtimeReadyPromise = null;
      throw error;
    });
  }
  return runtimeReadyPromise;
}

export default async function handler(req: any, res: any) {
  try {
    const mod = await loadAppModule();
    await ensureRuntimeReadyOnce();
    return mod.app(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vercel API bootstrap failed";
    console.error("[vercel-api] bootstrap failure:", error);
    res.status(503).json({ error: message });
  }
}
