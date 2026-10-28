import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Connection } from "mongoose";
import type { FastifyInstance } from "fastify";
import { generateApiKey, type UserTokenVerifier } from "@uap/auth";
import { loadConfig } from "@uap/config";
import { AppError, createLogger } from "@uap/core";
import { connectMongo, createModels, createRepositories, pingMongo, type Models } from "@uap/database";
import type { ChatResult, LlmProvider, ProviderRequest } from "@uap/llm-gateway";
import { createPawsattvaRoleResolver, PAWSATTVA_ROLE_SOURCE } from "@uap/pawsattva-firebase";
import { buildDeps } from "../src/runtime.js";
import { buildServer } from "../src/server.js";

// Integration test: real Fastify server, real MongoDB (in-memory), real repositories and auth.
// Only the LLM provider, the Firebase verifier and Redis are replaced.

const PEPPER = "test-pepper-".padEnd(40, "x");
let mongod: MongoMemoryServer;
let connection: Connection;
let models: Models;
let app: FastifyInstance;
let redisHealthy = true;
const llmCalls: ProviderRequest[] = [];

const fakeProvider: LlmProvider = {
  name: "fake",
  async chat(req: ProviderRequest): Promise<ChatResult> {
    llmCalls.push(req);
    return { id: "gen-1", provider: "fake", model: req.model, content: "Soft water is gentler on skin.", toolCalls: [], finishReason: "stop", usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20, costUsd: 0.0002 } };
  },
  async *stream() {
    throw new Error("not used");
  },
};

const fakeFirebase: UserTokenVerifier = {
  async verify(token) {
    // "firebase-good" is a generic user; "paw:<uid>" are PawSattva users looked up in fakePawsattvaDb.
    if (token.startsWith("paw:")) return { subject: token.slice(4) };
    if (token !== "firebase-good") throw new AppError("unauthenticated", "bad token");
    return { subject: "uid-42" };
  },
};

// PawSattva's Firestore, as the role resolver sees it (users/{uid}).
const pawsattvaUsers: Record<string, Record<string, unknown>> = {
  "users/parent": { admin: false },
  "users/boss": { admin: true, role: "admin" },
  "users/banned": { admin: false, blacklisted: true },
};
const fakePawsattvaDb = {
  doc: (path: string) => ({ get: async () => ({ exists: path in pawsattvaUsers, get: (field: string) => pawsattvaUsers[path]?.[field] }) }),
};

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
let platformKey: string;
let aquakartKey: string;
let aquakartClientId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const config = loadConfig({
    NODE_ENV: "test",
    MONGODB_URI: mongod.getUri("uap_test"),
    REDIS_URL: "redis://unused-in-tests",
    API_KEY_PEPPER: PEPPER,
    DEFAULT_LLM_MODEL: "test-vendor/test-model",
    LLM_MAX_RETRIES: "0",
    LOG_LEVEL: "silent",
  });
  const logger = createLogger({ level: "silent" });
  connection = await connectMongo({ uri: config.mongodbUri, logger, maxAttempts: 1 });
  models = createModels(connection);
  await Promise.all(Object.values(models).map((model) => model.init()));
  const repos = createRepositories(models);

  const deps = buildDeps({
    config,
    logger,
    repos,
    providers: [fakeProvider],
    verifiers: { firebase: fakeFirebase, jwt: fakeFirebase },
    roleResolvers: { [PAWSATTVA_ROLE_SOURCE]: createPawsattvaRoleResolver(fakePawsattvaDb) },
    health: {
      mongo: () => pingMongo(connection),
      redis: async () => {
        if (!redisHealthy) throw new Error("redis down");
      },
    },
  });
  app = await buildServer(deps);
  await app.ready();

  // Bootstrap exactly like the create-api-client CLI does.
  const key = generateApiKey(PEPPER);
  await repos.apiClients.create({ brandId: null, name: "ops", keyId: key.keyId, keyHash: key.keyHash, scopes: ["platform:admin"], roles: ["platform_admin"], createdBy: "test" });
  platformKey = key.plaintext;
});

afterAll(async () => {
  await app?.close();
  await connection?.close();
  await mongod?.stop();
});

describe("health", () => {
  it("reports liveness and dependency readiness without exposing secrets", async () => {
    expect((await app.inject({ url: "/health/live" })).json()).toEqual({ status: "ok" });
    const ready = await app.inject({ url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ok", checks: { mongo: { ok: true }, redis: { ok: true } }, integrations: { openrouter: false }, llmGateway: { configured: true } });

    redisHealthy = false;
    const degraded = await app.inject({ url: "/health/ready" });
    redisHealthy = true;
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json().checks.redis).toMatchObject({ ok: false, error: "redis down" });
  });

  it("serves the OpenAPI document", async () => {
    const res = await app.inject({ url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toEqual(expect.arrayContaining(["/api/v1/brands", "/api/v1/llm/completions", "/health/ready"]));
  });
});

describe("authentication and error shape", () => {
  it("returns 401 with the standard error body and echoes the request id", async () => {
    const res = await app.inject({ url: "/api/v1/brands", headers: { "x-request-id": "trace-12345678" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-request-id"]).toBe("trace-12345678");
    expect(res.json()).toEqual({ error: { code: "unauthenticated", message: "Authentication required", requestId: "trace-12345678" } });
  });

  it("rejects garbage and unknown API keys", async () => {
    expect((await app.inject({ url: "/api/v1/auth/me", headers: auth("uap_sk_nope") })).statusCode).toBe(401);
    const unknown = generateApiKey(PEPPER).plaintext;
    expect((await app.inject({ url: "/api/v1/auth/me", headers: auth(unknown) })).statusCode).toBe(401);
  });

  it("returns 404 in the standard shape for unknown routes", async () => {
    const res = await app.inject({ url: "/api/v1/nope", headers: auth(platformKey) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("brands (platform admin)", () => {
  it("creates brands, rejects duplicates and validates input", async () => {
    for (const slug of ["aquakart", "pawsattva"]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/brands", headers: auth(platformKey), payload: { slug, name: slug } });
      expect(res.statusCode).toBe(201);
    }
    const dup = await app.inject({ method: "POST", url: "/api/v1/brands", headers: auth(platformKey), payload: { slug: "aquakart", name: "x" } });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({ method: "POST", url: "/api/v1/brands", headers: auth(platformKey), payload: { slug: "Bad Slug!", name: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_failed");

    const list = await app.inject({ url: "/api/v1/brands", headers: auth(platformKey) });
    expect(list.json().items.map((b: { slug: string }) => b.slug)).toEqual(["aquakart", "pawsattva"]);
  });

  it("issues a brand-scoped key that is shown once and never returns its hash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/brands/aquakart/api-clients",
      headers: auth(platformKey),
      payload: { name: "aquakart-backend", scopes: ["brands:read", "brands:write", "applications:read", "applications:write", "api_clients:write", "llm:invoke"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.apiKey).toMatch(/^uap_sk_[0-9a-f]{16}_[0-9a-f]{64}$/);
    aquakartKey = body.apiKey;
    aquakartClientId = body.client.id;

    const list = await app.inject({ url: "/api/v1/brands/aquakart/api-clients", headers: auth(platformKey) });
    const raw = list.body;
    expect(raw).not.toContain("keyHash");
    expect(raw).not.toContain(aquakartKey.split("_").at(-1));

    const stored = await models.ApiClient.findById(aquakartClientId).select("+keyHash").lean();
    expect(stored?.keyHash).not.toContain(aquakartKey.split("_").at(-1));
  });
});

describe("tenant isolation", () => {
  it("derives the brand from the key, never from the request", async () => {
    const me = await app.inject({ url: "/api/v1/auth/me", headers: auth(aquakartKey) });
    const aquakart = await models.Brand.findOne({ slug: "aquakart" }).lean();
    expect(me.json()).toMatchObject({ kind: "api_client", brandId: aquakart?._id.toString() });
  });

  it("lists only the caller's brand", async () => {
    const res = await app.inject({ url: "/api/v1/brands", headers: auth(aquakartKey) });
    expect(res.json().items.map((b: { slug: string }) => b.slug)).toEqual(["aquakart"]);
  });

  it("blocks every route under another brand", async () => {
    const attempts = [
      { method: "GET" as const, url: "/api/v1/brands/pawsattva" },
      { method: "PATCH" as const, url: "/api/v1/brands/pawsattva", payload: { name: "pwned" } },
      { method: "GET" as const, url: "/api/v1/brands/pawsattva/applications" },
      { method: "POST" as const, url: "/api/v1/brands/pawsattva/applications", payload: { slug: "web", name: "x", kind: "web" } },
      { method: "GET" as const, url: "/api/v1/brands/pawsattva/api-clients" },
      { method: "POST" as const, url: "/api/v1/brands/pawsattva/api-clients", payload: { name: "x", scopes: ["llm:invoke"] } },
    ];
    for (const attempt of attempts) {
      const res = await app.inject({ ...attempt, headers: auth(aquakartKey) });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }
    expect((await models.Brand.findOne({ slug: "pawsattva" }).lean())?.name).toBe("pawsattva");
  });

  it("does not resolve another brand's application id through your own brand", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/brands/pawsattva/applications", headers: auth(platformKey), payload: { slug: "site", name: "Site", kind: "web" } });
    const otherAppId = created.json().id;
    const res = await app.inject({ url: `/api/v1/brands/aquakart/applications/${otherAppId}`, headers: auth(aquakartKey) });
    expect(res.statusCode).toBe(404);
  });
});

describe("privilege boundaries", () => {
  it("cannot delegate scopes the caller does not hold, nor platform:admin", async () => {
    const escalate = await app.inject({ method: "POST", url: "/api/v1/brands/aquakart/api-clients", headers: auth(aquakartKey), payload: { name: "x", scopes: ["content:publish"] } });
    expect(escalate.statusCode).toBe(403);
    const admin = await app.inject({ method: "POST", url: "/api/v1/brands/aquakart/api-clients", headers: auth(aquakartKey), payload: { name: "x", scopes: ["platform:admin"] } });
    expect(admin.statusCode).toBe(400);
  });

  it("lets brand admins edit branding but not budgets or routing", async () => {
    const ok = await app.inject({ method: "PATCH", url: "/api/v1/brands/aquakart", headers: auth(aquakartKey), payload: { name: "AquaKart", branding: { primaryColor: "#0077cc" } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: "AquaKart", branding: { primaryColor: "#0077cc" } });
    const budgets = await app.inject({ method: "PATCH", url: "/api/v1/brands/aquakart", headers: auth(aquakartKey), payload: { budgets: { dailyTokenLimit: 999_999 } } });
    expect(budgets.statusCode).toBe(403);
  });

  it("only platform admins create brands", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/brands", headers: auth(aquakartKey), payload: { slug: "spasta", name: "Spasta" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("applications and end-user auth", () => {
  let publishableKey: string;

  it("registers a Firebase-authenticated web app", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/brands/aquakart/applications",
      headers: auth(aquakartKey),
      payload: { slug: "storefront", name: "Storefront", kind: "web", allowedOrigins: ["https://aquakart.co.in"], auth: { provider: "firebase", firebaseProjectId: "aquakart-test" } },
    });
    expect(res.statusCode).toBe(201);
    publishableKey = res.json().publishableKey;
    expect(publishableKey).toMatch(/^pk_/);

    const invalid = await app.inject({ method: "POST", url: "/api/v1/brands/aquakart/applications", headers: auth(aquakartKey), payload: { slug: "x2", name: "x", kind: "web", auth: { provider: "firebase" } } });
    expect(invalid.statusCode).toBe(400);
  });

  it("verifies user tokens via the app and gives end users only chat scope", async () => {
    const headers = { authorization: "Bearer firebase-good", "x-uap-app": publishableKey, origin: "https://aquakart.co.in" };
    const me = await app.inject({ url: "/api/v1/auth/me", headers });
    expect(me.json()).toMatchObject({ kind: "user", id: "firebase:uid-42", scopes: ["chat:use"] });
    expect((await app.inject({ url: "/api/v1/brands", headers })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { ...headers, authorization: "Bearer forged" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { ...headers, origin: "https://evil.example" } })).statusCode).toBe(403);
  });
});

describe("brand-owned user roles (PawSattva)", () => {
  let pk: string;

  it("stores the role source on the application", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/brands/pawsattva/applications",
      headers: auth(platformKey),
      payload: { slug: "paw-gpt", name: "Paw GPT", kind: "web", auth: { provider: "firebase", firebaseProjectId: "pawsattva", roleSource: "pawsattva-firestore" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().auth.roleSource).toBe("pawsattva-firestore");
    pk = res.json().publishableKey;

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/brands/pawsattva/applications",
      headers: auth(platformKey),
      payload: { slug: "x3", name: "x", kind: "web", auth: { provider: "firebase", firebaseProjectId: "p", roleSource: "made-up" } },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("applies PawSattva roles and blocks restricted accounts", async () => {
    const me = (uid: string) => app.inject({ url: "/api/v1/auth/me", headers: { authorization: `Bearer paw:${uid}`, "x-uap-app": pk } });
    expect((await me("parent")).json()).toMatchObject({ roles: ["end_user"], scopes: ["chat:use"] });
    expect((await me("boss")).json()).toMatchObject({ roles: ["reviewer"], scopes: expect.arrayContaining(["content:review"]) });
    const banned = await me("banned");
    expect(banned.statusCode).toBe(403);
    expect(banned.json().error.message).toBe("Your account is restricted.");
    expect((await me("nobody")).statusCode).toBe(401);
  });

  it("does not let a PawSattva admin administer the platform", async () => {
    const headers = { authorization: "Bearer paw:boss", "x-uap-app": pk };
    expect((await app.inject({ url: "/api/v1/brands/pawsattva/api-clients", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/brands/pawsattva", headers, payload: { name: "x" } })).statusCode).toBe(403);
  });
});

describe("LLM gateway endpoint", () => {
  it("completes through the gateway and records usage against the caller's brand", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/llm/completions", headers: auth(aquakartKey), payload: { messages: [{ role: "user", content: "Why soften water?" }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ model: "test-vendor/test-model", content: "Soft water is gentler on skin.", usage: { totalTokens: 20, costUsd: 0.0002 } });
    expect(llmCalls.at(-1)?.model).toBe("test-vendor/test-model");

    const aquakart = await models.Brand.findOne({ slug: "aquakart" }).lean();
    const logs = await models.LlmUsageLog.find({ brandId: aquakart?._id }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ provider: "fake", status: "success", totalTokens: 20, costUsd: 0.0002 });
  });

  it("uses the brand's configured model when set", async () => {
    await app.inject({ method: "PATCH", url: "/api/v1/brands/aquakart", headers: auth(platformKey), payload: { defaultModel: "test-vendor/brand-model" } });
    await app.inject({ method: "POST", url: "/api/v1/llm/completions", headers: auth(aquakartKey), payload: { messages: [{ role: "user", content: "hi" }] } });
    expect(llmCalls.at(-1)?.model).toBe("test-vendor/brand-model");
  });

  it("enforces the brand budget before calling the provider", async () => {
    await app.inject({ method: "PATCH", url: "/api/v1/brands/aquakart", headers: auth(platformKey), payload: { budgets: { dailyTokenLimit: 30 } } });
    const before = llmCalls.length;
    const res = await app.inject({ method: "POST", url: "/api/v1/llm/completions", headers: auth(aquakartKey), payload: { messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("budget_exceeded");
    expect(llmCalls.length).toBe(before);
  });

  it("refuses callers without llm:invoke and brandless platform keys", async () => {
    const payload = { messages: [{ role: "user", content: "hi" }] };
    expect((await app.inject({ method: "POST", url: "/api/v1/llm/completions", headers: auth(platformKey), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/llm/completions", payload })).statusCode).toBe(401);
  });
});

describe("revocation and audit", () => {
  it("revoked keys stop working immediately and writes are audited", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/brands/aquakart/api-clients/${aquakartClientId}/revoke`, headers: auth(platformKey) });
    expect(res.json().status).toBe("revoked");
    expect((await app.inject({ url: "/api/v1/auth/me", headers: auth(aquakartKey) })).statusCode).toBe(401);

    const actions = (await models.AuditLog.find().lean()).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["brand.create", "api_client.create", "application.create", "brand.update", "api_client.revoke"]));
  });
});
