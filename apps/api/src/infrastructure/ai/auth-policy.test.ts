import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAiGatewayAuth } from "./auth-policy.js";

test("evaluateAiGatewayAuth: openclaw provider fails when gateway auth is missing", () => {
  const result = evaluateAiGatewayAuth({ provider: "openclaw", openClawAuthConfigured: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /OpenClaw gateway auth/);
});

test("evaluateAiGatewayAuth: openclaw provider passes when gateway auth is present", () => {
  const result = evaluateAiGatewayAuth({ provider: "openclaw", openClawAuthConfigured: true });
  assert.equal(result.ok, true);
});

test("evaluateAiGatewayAuth: hermes bridge mode requires OpenClaw auth", () => {
  const result = evaluateAiGatewayAuth({ provider: "hermes", openClawAuthConfigured: false, hermesMode: "bridge" });
  assert.equal(result.ok, false);
  assert.match(result.message, /Hermes bridge mode currently depends on OpenClaw gateway auth/);
});

test("evaluateAiGatewayAuth: hermes native mode fails when Hermes auth is missing", () => {
  const result = evaluateAiGatewayAuth({
    provider: "hermes",
    openClawAuthConfigured: false,
    hermesMode: "native",
    hermesNativeConfigured: false
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Hermes native runtime auth is not configured/);
});

test("evaluateAiGatewayAuth: hermes native mode passes when Hermes auth is configured", () => {
  const result = evaluateAiGatewayAuth({
    provider: "hermes",
    openClawAuthConfigured: false,
    hermesMode: "native",
    hermesNativeConfigured: true
  });
  assert.equal(result.ok, true);
});
