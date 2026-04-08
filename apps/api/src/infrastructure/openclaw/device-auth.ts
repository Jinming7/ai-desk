import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type OpenClawDeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type OpenClawDeviceAuthPayloadParams = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEVICE_AUTH_FILE = "device-auth.json";

type OpenClawDeviceAuthEntry = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type OpenClawDeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, OpenClawDeviceAuthEntry>;
};

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const openClawHome = trimToNull(env.OPENCLAW_HOME);
  if (openClawHome) {
    return openClawHome.startsWith("~/") ? path.join(os.homedir(), openClawHome.slice(2)) : openClawHome;
  }
  return trimToNull(env.HOME) ?? trimToNull(env.USERPROFILE) ?? os.homedir();
}

function resolveUserPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.startsWith("~") ? path.resolve(input.replace(/^~(?=$|[\\/])/, resolveHomeDir(env))) : path.resolve(input);
}

function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = trimToNull(env.OPENCLAW_STATE_DIR) ?? trimToNull(env.CLAWDBOT_STATE_DIR);
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveHomeDir(env), ".openclaw");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function generateIdentity(): OpenClawDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem
  };
}

function resolvePrimaryDeviceIdentityPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = trimToNull(env.OPENCLAW_DEVICE_IDENTITY_PATH);
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveOpenClawStateDir(env), "identity", "device.json");
}

function resolveFallbackDeviceIdentityPath(): string {
  return path.join(os.tmpdir(), "nexusflow-openclaw", "device.json");
}

function parseStoredIdentity(value: unknown): OpenClawDeviceIdentity | null {
  const parsed = value as Partial<OpenClawDeviceIdentity> & { version?: number };
  if (
    parsed?.version === 1 &&
    typeof parsed.deviceId === "string" &&
    typeof parsed.publicKeyPem === "string" &&
    typeof parsed.privateKeyPem === "string"
  ) {
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem
    };
  }
  return null;
}

function loadIdentityFromFile(filePath: string): OpenClawDeviceIdentity | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return parseStoredIdentity(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function parseEnvDeviceIdentity(identityJson: string): OpenClawDeviceIdentity {
  const parsed = JSON.parse(identityJson) as Partial<OpenClawDeviceIdentity>;
  if (
    typeof parsed.deviceId !== "string" ||
    typeof parsed.publicKeyPem !== "string" ||
    typeof parsed.privateKeyPem !== "string"
  ) {
    throw new Error("OPENCLAW_DEVICE_IDENTITY_JSON must include deviceId, publicKeyPem, and privateKeyPem");
  }
  return {
    deviceId: parsed.deviceId,
    publicKeyPem: parsed.publicKeyPem,
    privateKeyPem: parsed.privateKeyPem
  };
}

export function loadOrCreateOpenClawDeviceIdentity(
  filePath: string = resolvePrimaryDeviceIdentityPath()
): OpenClawDeviceIdentity {
  const identityFromEnv = trimToNull(process.env.OPENCLAW_DEVICE_IDENTITY_JSON);
  if (identityFromEnv) {
    return parseEnvDeviceIdentity(identityFromEnv);
  }

  const existingIdentity = loadIdentityFromFile(filePath);
  if (existingIdentity) {
    return existingIdentity;
  }

  const fallbackIdentity = filePath === resolveFallbackDeviceIdentityPath() ? null : loadIdentityFromFile(resolveFallbackDeviceIdentityPath());
  if (fallbackIdentity) {
    return fallbackIdentity;
  }

  const identity = generateIdentity();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        ...identity,
        createdAtMs: Date.now()
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return identity;
}

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = trimToNull(env.OPENCLAW_DEVICE_AUTH_PATH);
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveOpenClawStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function readDeviceAuthStore(filePath: string): OpenClawDeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as OpenClawDeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function loadOpenClawDeviceToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const effectiveEnv = params.env ?? process.env;
  const explicitToken = trimToNull(effectiveEnv.OPENCLAW_DEVICE_TOKEN);
  if (explicitToken) {
    return explicitToken;
  }

  const store = readDeviceAuthStore(resolveDeviceAuthPath(effectiveEnv));
  if (!store || store.deviceId !== params.deviceId) {
    return null;
  }
  const entry = store.tokens[params.role.trim()];
  return typeof entry?.token === "string" && entry.token.trim() ? entry.token.trim() : null;
}

export function storeOpenClawDeviceToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const effectiveEnv = params.env ?? process.env;
  const filePath = resolveDeviceAuthPath(effectiveEnv);
  const existing = readDeviceAuthStore(filePath);
  const role = params.role.trim();
  const next: OpenClawDeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? { ...existing.tokens }
        : {}
  };
  next.tokens[role] = {
    token: params.token,
    role,
    scopes: Array.isArray(params.scopes) ? params.scopes.map((item) => item.trim()).filter(Boolean).sort() : [],
    updatedAtMs: Date.now()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export function clearOpenClawDeviceToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const effectiveEnv = params.env ?? process.env;
  const filePath = resolveDeviceAuthPath(effectiveEnv);
  const existing = readDeviceAuthStore(filePath);
  if (!existing || existing.deviceId !== params.deviceId) {
    return;
  }
  const role = params.role.trim();
  if (!existing.tokens[role]) {
    return;
  }
  const next: OpenClawDeviceAuthStore = {
    version: 1,
    deviceId: existing.deviceId,
    tokens: { ...existing.tokens }
  };
  delete next.tokens[role];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export function buildOpenClawDeviceAuthPayload(params: OpenClawDeviceAuthPayloadParams): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce
  ].join("|");
}

export function signOpenClawDevicePayload(privateKeyPem: string, payload: string): string {
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem)));
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function buildSignedOpenClawDevice(input: {
  identity: OpenClawDeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}) {
  const payload = buildOpenClawDeviceAuthPayload({
    deviceId: input.identity.deviceId,
    clientId: input.clientId,
    clientMode: input.clientMode,
    role: input.role,
    scopes: input.scopes,
    signedAtMs: input.signedAtMs,
    token: input.token ?? null,
    nonce: input.nonce
  });

  return {
    id: input.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(input.identity.publicKeyPem),
    signature: signOpenClawDevicePayload(input.identity.privateKeyPem, payload),
    signedAt: input.signedAtMs,
    nonce: input.nonce
  };
}
