import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { env } from "../../config/env.js";
import { embedText } from "./embedding.js";

async function withEmbeddingServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to resolve embedding test server address");
  }

  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("embedText accepts a custom provider when vector dimensions match env", async () => {
  const original = {
    provider: env.GITHUB_KB_EMBEDDING_PROVIDER,
    base: env.GITHUB_KB_EMBEDDING_API_BASE,
    key: env.GITHUB_KB_EMBEDDING_API_KEY,
    model: env.GITHUB_KB_EMBEDDING_MODEL,
    dim: env.GITHUB_KB_VECTOR_DIM
  };

  try {
    await withEmbeddingServer((req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/embeddings");

      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const payload = JSON.parse(body) as { model: string; input: string };
        assert.equal(payload.model, "bge-m3");
        assert.match(payload.input, /custom provider smoke/i);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "bge-m3",
            data: [{ embedding: Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)) }]
          })
        );
      });
    }, async (baseUrl) => {
      env.GITHUB_KB_EMBEDDING_PROVIDER = "custom";
      env.GITHUB_KB_EMBEDDING_API_BASE = baseUrl;
      env.GITHUB_KB_EMBEDDING_API_KEY = "test-key";
      env.GITHUB_KB_EMBEDDING_MODEL = "bge-m3";
      env.GITHUB_KB_VECTOR_DIM = 1024;

      const result = await embedText("custom provider smoke");
      assert.equal(result.model, "bge-m3");
      assert.equal(result.vector.length, 1024);
      assert.equal(result.vector[0], 1);
    });
  } finally {
    env.GITHUB_KB_EMBEDDING_PROVIDER = original.provider;
    env.GITHUB_KB_EMBEDDING_API_BASE = original.base;
    env.GITHUB_KB_EMBEDDING_API_KEY = original.key;
    env.GITHUB_KB_EMBEDDING_MODEL = original.model;
    env.GITHUB_KB_VECTOR_DIM = original.dim;
  }
});

test("embedText rejects custom provider responses with the wrong dimension count", async () => {
  const original = {
    provider: env.GITHUB_KB_EMBEDDING_PROVIDER,
    base: env.GITHUB_KB_EMBEDDING_API_BASE,
    key: env.GITHUB_KB_EMBEDDING_API_KEY,
    model: env.GITHUB_KB_EMBEDDING_MODEL,
    dim: env.GITHUB_KB_VECTOR_DIM
  };

  try {
    await withEmbeddingServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "bge-m3",
          data: [{ embedding: Array.from({ length: 1024 }, () => 0) }]
        })
      );
    }, async (baseUrl) => {
      env.GITHUB_KB_EMBEDDING_PROVIDER = "custom";
      env.GITHUB_KB_EMBEDDING_API_BASE = baseUrl;
      env.GITHUB_KB_EMBEDDING_API_KEY = "test-key";
      env.GITHUB_KB_EMBEDDING_MODEL = "bge-m3";
      env.GITHUB_KB_VECTOR_DIM = 1536;

      await assert.rejects(
        () => embedText("custom provider mismatch"),
        /Embedding API returned 1024 dimensions, expected 1536/
      );
    });
  } finally {
    env.GITHUB_KB_EMBEDDING_PROVIDER = original.provider;
    env.GITHUB_KB_EMBEDDING_API_BASE = original.base;
    env.GITHUB_KB_EMBEDDING_API_KEY = original.key;
    env.GITHUB_KB_EMBEDDING_MODEL = original.model;
    env.GITHUB_KB_VECTOR_DIM = original.dim;
  }
});
