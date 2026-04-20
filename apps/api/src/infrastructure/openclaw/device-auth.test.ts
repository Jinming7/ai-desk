import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildOpenClawDeviceAuthPayload,
  buildSignedOpenClawDevice,
  hasOpenClawGatewayAuthConfigured,
  loadOpenClawDeviceToken,
  loadOrCreateOpenClawDeviceIdentity,
  storeOpenClawDeviceToken
} from "./device-auth.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

test("buildOpenClawDeviceAuthPayload uses the v2 nonce-signed payload layout", () => {
  const payload = buildOpenClawDeviceAuthPayload({
    deviceId: "device-1",
    clientId: "gateway-client",
    clientMode: "backend",
    role: "operator",
    scopes: ["operator.admin"],
    signedAtMs: 1_770_000_000_000,
    token: "shared-token",
    nonce: "challenge-nonce"
  });

  assert.equal(
    payload,
    "v2|device-1|gateway-client|backend|operator|operator.admin|1770000000000|shared-token|challenge-nonce"
  );
});

test("buildSignedOpenClawDevice signs the challenge nonce with the device identity", () => {
  const identity = loadOrCreateOpenClawDeviceIdentity();
  const signedAtMs = Date.now();
  const payload = buildOpenClawDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: "gateway-client",
    clientMode: "backend",
    role: "operator",
    scopes: ["operator.admin"],
    signedAtMs,
    token: "shared-token",
    nonce: "nonce-123"
  });
  const device = buildSignedOpenClawDevice({
    identity,
    clientId: "gateway-client",
    clientMode: "backend",
    role: "operator",
    scopes: ["operator.admin"],
    signedAtMs,
    token: "shared-token",
    nonce: "nonce-123"
  });

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, decodeBase64Url(device.publicKey)]),
    type: "spki",
    format: "der"
  });

  assert.equal(device.id, identity.deviceId);
  assert.equal(device.nonce, "nonce-123");
  assert.equal(device.signedAt, signedAtMs);
  assert.equal(
    crypto.verify(null, Buffer.from(payload, "utf8"), publicKey, decodeBase64Url(device.signature)),
    true
  );
});

test("loadOrCreateOpenClawDeviceIdentity prefers OPENCLAW_DEVICE_IDENTITY_JSON when provided", () => {
  const original = process.env.OPENCLAW_DEVICE_IDENTITY_JSON;
  process.env.OPENCLAW_DEVICE_IDENTITY_JSON = JSON.stringify({
    deviceId: "env-device",
    publicKeyPem: "public-key",
    privateKeyPem: "private-key"
  });

  try {
    const identity = loadOrCreateOpenClawDeviceIdentity();
    assert.deepEqual(identity, {
      deviceId: "env-device",
      publicKeyPem: "public-key",
      privateKeyPem: "private-key"
    });
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_DEVICE_IDENTITY_JSON;
    else process.env.OPENCLAW_DEVICE_IDENTITY_JSON = original;
  }
});

test("loadOpenClawDeviceToken prefers OPENCLAW_DEVICE_TOKEN when provided", () => {
  const original = process.env.OPENCLAW_DEVICE_TOKEN;
  process.env.OPENCLAW_DEVICE_TOKEN = "device-token-from-env";

  try {
    assert.equal(
      loadOpenClawDeviceToken({
        deviceId: "env-device",
        role: "operator"
      }),
      "device-token-from-env"
    );
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_DEVICE_TOKEN;
    else process.env.OPENCLAW_DEVICE_TOKEN = original;
  }
});

test("hasOpenClawGatewayAuthConfigured accepts OPENCLAW_DEVICE_TOKEN as valid auth", () => {
  const originalDeviceToken = process.env.OPENCLAW_DEVICE_TOKEN;
  const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalBasicPass = process.env.OPENCLAW_BASIC_PASS;

  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_BASIC_PASS;
  process.env.OPENCLAW_DEVICE_TOKEN = "device-token-from-env";

  try {
    assert.equal(hasOpenClawGatewayAuthConfigured(), true);
  } finally {
    if (originalDeviceToken === undefined) delete process.env.OPENCLAW_DEVICE_TOKEN;
    else process.env.OPENCLAW_DEVICE_TOKEN = originalDeviceToken;

    if (originalGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;

    if (originalBasicPass === undefined) delete process.env.OPENCLAW_BASIC_PASS;
    else process.env.OPENCLAW_BASIC_PASS = originalBasicPass;
  }
});

test("loadOpenClawDeviceToken falls back to the stored OpenClaw device-auth file", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-device-auth-test-"));
  const identityDir = path.join(stateDir, "identity");
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(
    path.join(identityDir, "device-auth.json"),
    `${JSON.stringify(
      {
        version: 1,
        deviceId: "stored-device",
        tokens: {
          operator: {
            token: "stored-operator-token",
            role: "operator",
            scopes: ["operator.admin"],
            updatedAtMs: 1_770_000_000_000
          }
        }
      },
      null,
      2
    )}\n`
  );

  assert.equal(
    loadOpenClawDeviceToken({
      deviceId: "stored-device",
      role: "operator",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir
      }
    }),
    "stored-operator-token"
  );
});

test("loadOrCreateOpenClawDeviceIdentity falls back to tmp storage when the primary path is not writable", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-device-fallback-"));
  const originalTmpdir = process.env.TMPDIR;
  const originalIdentityJson = process.env.OPENCLAW_DEVICE_IDENTITY_JSON;
  const fallbackPath = path.join(tempRoot, "nexusflow-openclaw", "device.json");

  delete process.env.OPENCLAW_DEVICE_IDENTITY_JSON;
  process.env.TMPDIR = tempRoot;

  try {
    const identity = loadOrCreateOpenClawDeviceIdentity("/dev/null/openclaw/device.json");
    assert.equal(fs.existsSync(fallbackPath), true);
    const stored = JSON.parse(fs.readFileSync(fallbackPath, "utf8")) as {
      deviceId: string;
      publicKeyPem: string;
      privateKeyPem: string;
    };
    assert.equal(stored.deviceId, identity.deviceId);
    assert.equal(stored.publicKeyPem, identity.publicKeyPem);
    assert.equal(stored.privateKeyPem, identity.privateKeyPem);
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    if (originalIdentityJson === undefined) delete process.env.OPENCLAW_DEVICE_IDENTITY_JSON;
    else process.env.OPENCLAW_DEVICE_IDENTITY_JSON = originalIdentityJson;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("storeOpenClawDeviceToken falls back to tmp storage when the primary auth path is not writable", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-device-token-fallback-"));
  const originalTmpdir = process.env.TMPDIR;
  const fallbackPath = path.join(tempRoot, "nexusflow-openclaw", "device-auth.json");

  process.env.TMPDIR = tempRoot;

  try {
    storeOpenClawDeviceToken({
      deviceId: "fallback-device",
      role: "operator",
      token: "fallback-token",
      scopes: ["operator.admin"],
      env: {
        ...process.env,
        OPENCLAW_DEVICE_AUTH_PATH: "/dev/null/openclaw/device-auth.json"
      }
    });

    assert.equal(fs.existsSync(fallbackPath), true);
    assert.equal(
      loadOpenClawDeviceToken({
        deviceId: "fallback-device",
        role: "operator",
        env: {
          ...process.env,
          OPENCLAW_DEVICE_AUTH_PATH: "/dev/null/openclaw/device-auth.json"
        }
      }),
      "fallback-token"
    );
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
