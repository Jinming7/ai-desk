import assert from "node:assert/strict";
import { test } from "node:test";
import { MockOpenClawAdapter } from "../openclaw/mock-adapter.js";
import { WsOpenClawAdapter } from "../openclaw/ws-adapter.js";
import { HermesOpenClawAdapter } from "../hermes/adapter.js";
import { HermesNativeAdapter } from "../hermes/native-adapter.js";
import { createAiAdapter, resolveAiRuntimeProvider } from "./adapter-factory.js";

test("resolveAiRuntimeProvider normalizes case and trims whitespace", () => {
  assert.equal(resolveAiRuntimeProvider(" Hermes "), "hermes");
  assert.equal(resolveAiRuntimeProvider("OPENCLAW"), "openclaw");
});

test("resolveAiRuntimeProvider falls back to openclaw on invalid values", () => {
  assert.equal(resolveAiRuntimeProvider("unknown-provider"), "openclaw");
});

test("createAiAdapter always returns MockOpenClawAdapter in test env", () => {
  const adapter = createAiAdapter({ nodeEnv: "test", provider: "hermes", hermesMode: "native" });
  assert.equal(adapter instanceof MockOpenClawAdapter, true);
});

test("createAiAdapter returns WsOpenClawAdapter when provider=openclaw", () => {
  const adapter = createAiAdapter({ nodeEnv: "development", provider: "openclaw" });
  assert.equal(adapter instanceof WsOpenClawAdapter, true);
});

test("createAiAdapter returns HermesOpenClawAdapter when provider=hermes", () => {
  const adapter = createAiAdapter({ nodeEnv: "production", provider: "hermes", hermesMode: "bridge" });
  assert.equal(adapter instanceof HermesOpenClawAdapter, true);
});

test("createAiAdapter returns HermesNativeAdapter when provider=hermes and mode=native", () => {
  const adapter = createAiAdapter({ nodeEnv: "production", provider: "hermes", hermesMode: "native" });
  assert.equal(adapter instanceof HermesNativeAdapter, true);
});
