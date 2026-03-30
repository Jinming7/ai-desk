import { app, ensureAiRuntimeReady } from "./app.js";
import { env } from "./config/env.js";

await ensureAiRuntimeReady();

app.listen(env.PORT, () => {
  console.log(`NexusFlow API listening on http://localhost:${env.PORT}`);
});
