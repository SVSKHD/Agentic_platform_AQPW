import { describe, expect, it, vi } from "vitest";
import { AppError } from "@uap/core";
import type { Principal } from "@uap/shared-types";
import {
  assertBrandAccess,
  createAuthenticator,
  generateApiKey,
  parseApiKey,
  requireScopes,
  verifyApiKeySecret,
  type ApiClientRecord,
  type ApplicationRecord,
  type AuthStores,
  type UserTokenVerifier,
} from "../src/index.js";

const PEPPER = "p".repeat(32);
const id = (value: string) => ({ toString: () => value });

const setup = (overrides: { client?: Partial<ApiClientRecord>; app?: Partial<ApplicationRecord> } = {}) => {
  const key = generateApiKey(PEPPER);
  const client: ApiClientRecord = { _id: id("client1"), brandId: id("brandA"), applicationId: null, keyHash: key.keyHash, scopes: ["llm:invoke"], roles: ["service"], ...overrides.client };
  const app: ApplicationRecord = { _id: id("app1"), brandId: id("brandA"), allowedOrigins: [], auth: { provider: "firebase", firebaseProjectId: "proj" }, anonymous: { enabled: false }, ...overrides.app };
  const stores: AuthStores = {
    findActiveApiClient: vi.fn(async (keyId: string) => (keyId === key.keyId ? client : null)),
    touchApiClient: vi.fn(async () => undefined),
    findActiveApplication: vi.fn(async (pk: string) => (pk === "pk_test" ? app : null)),
  };
  const firebase: UserTokenVerifier = {
    verify: vi.fn(async (token: string) => {
      if (token !== "good-token") throw new AppError("unauthenticated", "bad token");
      return { subject: "uid-1" };
    }),
  };
  const jwt: UserTokenVerifier = { verify: vi.fn() };
  const authenticate = createAuthenticator({ stores, pepper: PEPPER, verifiers: { firebase, jwt } });
  return { key, authenticate, stores, firebase };
};

describe("API keys", () => {
  it("round-trips generate -> parse -> verify, and rejects a wrong secret", () => {
    const key = generateApiKey(PEPPER);
    const parsed = parseApiKey(key.plaintext);
    expect(parsed?.keyId).toBe(key.keyId);
    expect(verifyApiKeySecret(PEPPER, parsed!.secret, key.keyHash)).toBe(true);
    expect(verifyApiKeySecret(PEPPER, "0".repeat(64), key.keyHash)).toBe(false);
    expect(verifyApiKeySecret("q".repeat(32), parsed!.secret, key.keyHash)).toBe(false);
  });

  it("does not embed the secret in the stored hash", () => {
    const key = generateApiKey(PEPPER);
    expect(key.plaintext).not.toContain(key.keyHash);
  });
});

describe("authenticate", () => {
  it("returns null when no credentials are sent", async () => {
    expect(await setup().authenticate({})).toBeNull();
  });

  it("authenticates a brand API key and derives the brand server-side", async () => {
    const { key, authenticate } = setup();
    const principal = await authenticate({ authorization: `Bearer ${key.plaintext}` });
    expect(principal).toMatchObject({ kind: "api_client", id: "client1", brandId: "brandA", scopes: ["llm:invoke"] });
  });

  it("rejects a tampered key, an expired key and a brandless non-admin key", async () => {
    const { key, authenticate } = setup();
    await expect(authenticate({ authorization: `Bearer ${key.plaintext.slice(0, -1)}0` })).rejects.toMatchObject({ code: "unauthenticated" });

    const expired = setup({ client: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(expired.authenticate({ authorization: `Bearer ${expired.key.plaintext}` })).rejects.toThrow(/expired/);

    const brandless = setup({ client: { brandId: null } });
    await expect(brandless.authenticate({ authorization: `Bearer ${brandless.key.plaintext}` })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("verifies end-user tokens through the application's provider", async () => {
    const { authenticate, firebase } = setup();
    const principal = await authenticate({ authorization: "Bearer good-token", appKey: "pk_test" });
    expect(principal).toMatchObject({ kind: "user", id: "firebase:uid-1", brandId: "brandA", applicationId: "app1", scopes: ["chat:use"] });
    expect(firebase.verify).toHaveBeenCalledWith("good-token", expect.objectContaining({ firebaseProjectId: "proj" }));
    await expect(authenticate({ authorization: "Bearer bad", appKey: "pk_test" })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("refuses a user token without an application, and unknown applications", async () => {
    const { authenticate } = setup();
    await expect(authenticate({ authorization: "Bearer good-token" })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(authenticate({ appKey: "pk_nope" })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("allows anonymous use only when the application enables it", async () => {
    await expect(setup().authenticate({ appKey: "pk_test", anonymousId: "a".repeat(20) })).rejects.toThrow(/Sign-in required/);
    const open = setup({ app: { anonymous: { enabled: true } } });
    expect(await open.authenticate({ appKey: "pk_test", anonymousId: "a".repeat(20) })).toMatchObject({ kind: "anonymous", id: `anon:${"a".repeat(20)}` });
    await expect(open.authenticate({ appKey: "pk_test" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("enforces the application's origin allowlist", async () => {
    const { authenticate } = setup({ app: { allowedOrigins: ["https://aquakart.co.in"] } });
    await expect(authenticate({ authorization: "Bearer good-token", appKey: "pk_test", origin: "https://evil.example" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await authenticate({ authorization: "Bearer good-token", appKey: "pk_test", origin: "https://aquakart.co.in" })).not.toBeNull();
  });
});

describe("authorization", () => {
  const brandKey: Principal = { kind: "api_client", id: "c", brandId: "brandA", applicationId: null, scopes: ["brands:read"], roles: ["service"] };
  const platform: Principal = { ...brandKey, brandId: null, scopes: ["platform:admin"] };
  // An end user can never act as platform admin, even with a forged scope list.
  const user: Principal = { ...brandKey, kind: "user", scopes: ["platform:admin"] };

  it("checks scopes, with platform:admin implying all for API clients only", () => {
    expect(() => requireScopes(brandKey, "brands:read")).not.toThrow();
    expect(() => requireScopes(brandKey, "brands:write")).toThrow(/brands:write/);
    expect(() => requireScopes(platform, "brands:write")).not.toThrow();
    expect(() => requireScopes(null, "brands:read")).toThrow(/Authentication required/);
  });

  it("isolates brands", () => {
    expect(() => assertBrandAccess(brandKey, "brandA")).not.toThrow();
    expect(() => assertBrandAccess(brandKey, "brandB")).toThrow(/access to this brand/);
    expect(() => assertBrandAccess(platform, "brandB")).not.toThrow();
    expect(() => assertBrandAccess(user, "brandB")).toThrow();
  });
});
