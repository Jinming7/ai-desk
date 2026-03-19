let appPromise: Promise<(req: any, res: any) => unknown> | null = null;

async function loadApp() {
  if (!appPromise) {
    appPromise = import("../apps/api/src/app.js").then((mod) => mod.app);
  }
  return appPromise;
}

export default async function handler(req: any, res: any) {
  const app = await loadApp();
  return app(req, res);
}
