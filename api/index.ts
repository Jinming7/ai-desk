export default async function handler(req: any, res: any) {
  const { app } = await import("../apps/api/src/app.js");
  return app(req, res);
}
