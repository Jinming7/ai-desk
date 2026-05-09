import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawHealthCheckResult
} from "../openclaw/types.js";
import { HermesOpenClawAdapter } from "./adapter.js";

test("HermesOpenClawAdapter rewrites health mode to hermes while preserving reachability fields", async () => {
  const bridge = {
    async healthCheck(): Promise<OpenClawHealthCheckResult> {
      return {
        ok: true,
        mode: "ws",
        detail: "Connected to upstream gateway",
        configuredAgents: ["support-router"],
        reachableAgents: ["support-router"],
        unreachableAgents: []
      };
    }
  } as unknown as OpenClawAdapter;

  const adapter = new HermesOpenClawAdapter(bridge);
  const health = await adapter.healthCheck();

  assert.equal(health.mode, "hermes");
  assert.equal(health.ok, true);
  assert.deepEqual(health.reachableAgents, ["support-router"]);
  assert.match(String(health.detail), /via hermes bridge/);
});

test("HermesOpenClawAdapter delegates analyzeTicket to bridge adapter", async () => {
  const expected: OpenClawAnalyzeOutput = {
    action: "ask_user",
    confidence: 0.6,
    reply: "Need more details",
    reasoning_summary: "missing context",
    evidence: [],
    risk_flags: []
  };
  const calls: Array<{ input: OpenClawAnalyzeInput; idempotencyKey: string }> = [];

  const bridge = {
    async healthCheck(): Promise<OpenClawHealthCheckResult> {
      return { ok: true, mode: "ws" };
    },
    async analyzeTicket(input: OpenClawAnalyzeInput, idempotencyKey: string): Promise<OpenClawAnalyzeOutput> {
      calls.push({ input, idempotencyKey });
      return expected;
    }
  } as unknown as OpenClawAdapter;

  const adapter = new HermesOpenClawAdapter(bridge);
  const result = await adapter.analyzeTicket(
    {
      ticket_id: "t-1",
      title: "title",
      description: "desc",
      priority: "P2",
      customer_meta: {},
      history: []
    },
    "idem-1"
  );

  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.idempotencyKey, "idem-1");
});
