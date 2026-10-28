import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Format: uap_sk_<keyId:16 hex>_<secret:64 hex>. keyId is a public lookup handle; the secret is never stored.
const KEY_PATTERN = /^uap_sk_([0-9a-f]{16})_([0-9a-f]{64})$/;

export const API_KEY_PREFIX = "uap_sk_";

export const hashApiKeySecret = (pepper: string, secret: string): string =>
  createHmac("sha256", pepper).update(secret).digest("hex");

export const generateApiKey = (pepper: string) => {
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return { keyId, plaintext: `${API_KEY_PREFIX}${keyId}_${secret}`, keyHash: hashApiKeySecret(pepper, secret) };
};

export const parseApiKey = (value: string): { keyId: string; secret: string } | null => {
  const match = KEY_PATTERN.exec(value);
  return match ? { keyId: match[1] as string, secret: match[2] as string } : null;
};

export const verifyApiKeySecret = (pepper: string, secret: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashApiKeySecret(pepper, secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
