import crypto from "node:crypto";
import { env } from "../config/env.js";

function getKey(): Buffer {
  return crypto.createHash("sha256").update(env.ONES_SYNC_ENCRYPTION_KEY).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted secret payload");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64")), decipher.final()]).toString("utf8");
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 6) return `${secret.slice(0, 1)}***${secret.slice(-1)}`;
  return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
}
