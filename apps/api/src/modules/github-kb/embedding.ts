import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { fetchWithNodeCompat } from "../../utils/fetch-compat.js";

function hashToUnitFloat(input: string): number {
  const digest = crypto.createHash("sha256").update(input).digest();
  const int = digest.readUInt32BE(0);
  return int / 0xffffffff;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

function buildMockEmbedding(text: string, dimensions: number): number[] {
  const base = text.trim() || "empty";
  const values: number[] = [];
  for (let i = 0; i < dimensions; i += 1) {
    const value = hashToUnitFloat(`${base}:${i}`) * 2 - 1;
    values.push(value);
  }
  return normalizeVector(values);
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number(v.toFixed(8))).join(",")}]`;
}

export async function embedText(text: string): Promise<{ vector: number[]; model: string; version: string }> {
  const provider = env.GITHUB_KB_EMBEDDING_PROVIDER;
  const dimensions = env.GITHUB_KB_VECTOR_DIM;

  if (provider === "mock") {
    return {
      vector: buildMockEmbedding(text, dimensions),
      model: "mock-hash",
      version: "v1"
    };
  }

  if (!env.GITHUB_KB_EMBEDDING_API_KEY) {
    throw new Error("GITHUB_KB_EMBEDDING_API_KEY is required when embedding provider is openai");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.GITHUB_KB_EMBEDDING_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof fetchWithNodeCompat>>;
  try {
    response = await fetchWithNodeCompat(`${env.GITHUB_KB_EMBEDDING_API_BASE.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GITHUB_KB_EMBEDDING_API_KEY}`
      },
      body: JSON.stringify({
        model: env.GITHUB_KB_EMBEDDING_MODEL,
        input: text,
        encoding_format: "float"
      }),
      signal: controller.signal
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new Error(`Embedding API timed out after ${env.GITHUB_KB_EMBEDDING_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
    model?: string;
  };

  const vector = payload.data[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding API returned empty vector");
  }

  return {
    vector,
    model: payload.model ?? env.GITHUB_KB_EMBEDDING_MODEL,
    version: "v1"
  };
}
