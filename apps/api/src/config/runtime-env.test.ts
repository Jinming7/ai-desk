import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isServerlessRuntime, shouldStartBackgroundLoops } from "./runtime-env.js";

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
  AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME,
  LAMBDA_TASK_ROOT: process.env.LAMBDA_TASK_ROOT,
  AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV
};

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;

  if (ORIGINAL_ENV.VERCEL === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = ORIGINAL_ENV.VERCEL;

  if (ORIGINAL_ENV.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_ENV.VERCEL_ENV;

  if (ORIGINAL_ENV.VERCEL_URL === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = ORIGINAL_ENV.VERCEL_URL;

  if (ORIGINAL_ENV.AWS_LAMBDA_FUNCTION_NAME === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  else process.env.AWS_LAMBDA_FUNCTION_NAME = ORIGINAL_ENV.AWS_LAMBDA_FUNCTION_NAME;

  if (ORIGINAL_ENV.LAMBDA_TASK_ROOT === undefined) delete process.env.LAMBDA_TASK_ROOT;
  else process.env.LAMBDA_TASK_ROOT = ORIGINAL_ENV.LAMBDA_TASK_ROOT;

  if (ORIGINAL_ENV.AWS_EXECUTION_ENV === undefined) delete process.env.AWS_EXECUTION_ENV;
  else process.env.AWS_EXECUTION_ENV = ORIGINAL_ENV.AWS_EXECUTION_ENV;
});

test("isServerlessRuntime treats vercel preview env as serverless", () => {
  delete process.env.VERCEL;
  process.env.VERCEL_ENV = "preview";
  delete process.env.VERCEL_URL;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.LAMBDA_TASK_ROOT;
  delete process.env.AWS_EXECUTION_ENV;

  assert.equal(isServerlessRuntime(), true);
});

test("isServerlessRuntime treats vercel deployment url as serverless", () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.VERCEL_URL = "ai-desk-preview.vercel.app";
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.LAMBDA_TASK_ROOT;
  delete process.env.AWS_EXECUTION_ENV;

  assert.equal(isServerlessRuntime(), true);
});

test("shouldStartBackgroundLoops stays disabled on vercel preview", () => {
  process.env.NODE_ENV = "production";
  delete process.env.VERCEL;
  process.env.VERCEL_ENV = "preview";
  delete process.env.VERCEL_URL;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.LAMBDA_TASK_ROOT;
  delete process.env.AWS_EXECUTION_ENV;

  assert.equal(shouldStartBackgroundLoops(), false);
});
