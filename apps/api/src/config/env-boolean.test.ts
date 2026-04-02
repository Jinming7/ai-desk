import assert from "node:assert/strict";
import { test } from "node:test";
import { envBoolean, parseBooleanEnvValue } from "./env-boolean.js";

test("parseBooleanEnvValue maps explicit string booleans instead of JavaScript truthiness", () => {
  assert.equal(parseBooleanEnvValue("true"), true);
  assert.equal(parseBooleanEnvValue("false"), false);
  assert.equal(parseBooleanEnvValue("1"), true);
  assert.equal(parseBooleanEnvValue("0"), false);
  assert.equal(parseBooleanEnvValue(" yes "), true);
  assert.equal(parseBooleanEnvValue(" off "), false);
});

test("envBoolean preserves defaults for undefined and accepts native booleans", () => {
  const schema = envBoolean(false);

  assert.equal(schema.parse(undefined), false);
  assert.equal(schema.parse(true), true);
  assert.equal(schema.parse(false), false);
});

test("envBoolean rejects ambiguous strings instead of silently coercing them", () => {
  const schema = envBoolean(false);

  assert.throws(() => schema.parse("maybe"), /boolean/i);
});
