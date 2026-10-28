import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Connection } from "mongoose";
import { createLogger } from "@uap/core";
import { connectMongo, createModels, createRepositories, RETENTION, type Models, type Repositories } from "../src/index.js";

let mongod: MongoMemoryServer;
let connection: Connection;
let models: Models;
let repos: Repositories;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = await connectMongo({ uri: mongod.getUri("uap_db_test"), logger: createLogger({ level: "silent" }), maxAttempts: 1 });
  models = createModels(connection);
  await Promise.all(Object.values(models).map((model) => model.init()));
  repos = createRepositories(models);
});

afterAll(async () => {
  await connection?.close();
  await mongod?.stop();
});

describe("brands.ensure (seed)", () => {
  it("creates once and never overwrites an existing brand", async () => {
    const first = await repos.brands.ensure({ slug: "spasta", name: "Spasta" });
    expect(first.created).toBe(true);
    await repos.brands.update("spasta", { name: "Spasta (edited by owner)" });

    const second = await repos.brands.ensure({ slug: "spasta", name: "Spasta" });
    expect(second.created).toBe(false);
    expect(second.brand.name).toBe("Spasta (edited by owner)");
    expect(await models.Brand.countDocuments({ slug: "spasta" })).toBe(1);
  });
});

describe("tenant-scoped repositories", () => {
  it("never returns another brand's application, even with a valid id", async () => {
    const a = await repos.brands.create({ slug: "brand-a", name: "A" });
    const b = await repos.brands.create({ slug: "brand-b", name: "B" });
    const appB = await repos.applications.create(b._id.toString(), { slug: "web", name: "Web", kind: "web" });

    await expect(repos.applications.getForBrand(a._id.toString(), appB._id.toString())).rejects.toMatchObject({ code: "not_found" });
    await expect(repos.applications.update(a._id.toString(), appB._id.toString(), { name: "hijack" })).rejects.toMatchObject({ code: "not_found" });
    expect((await repos.applications.getForBrand(b._id.toString(), appB._id.toString())).name).toBe("Web");
    expect(await repos.applications.listForBrand(a._id.toString())).toHaveLength(0);
  });

  it("treats malformed ids as not found rather than throwing a cast error", async () => {
    const a = await repos.brands.getBySlug("brand-a");
    await expect(repos.applications.getForBrand(a._id.toString(), "not-an-id")).rejects.toMatchObject({ code: "not_found" });
  });

  it("aggregates usage per brand for budget checks", async () => {
    const a = await repos.brands.getBySlug("brand-a");
    const b = await repos.brands.getBySlug("brand-b");
    const entry = { requestId: "r", provider: "p", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 5, status: "success" as const };
    await repos.usage.record({ ...entry, brandId: a._id.toString(), totalTokens: 100, costUsd: 0.5 });
    await repos.usage.record({ ...entry, brandId: a._id.toString(), totalTokens: 50, costUsd: null });
    await repos.usage.record({ ...entry, brandId: b._id.toString(), totalTokens: 999, costUsd: 9 });
    expect(await repos.usage.totalsSince(a._id.toString(), new Date(0))).toEqual({ totalTokens: 150, costUsd: 0.5 });
  });
});

describe("indexes and retention", () => {
  it("creates TTL indexes matching the documented retention", async () => {
    const usageIndexes = await models.LlmUsageLog.collection.indexes();
    const auditIndexes = await models.AuditLog.collection.indexes();
    expect(usageIndexes.find((i) => i.expireAfterSeconds !== undefined)?.expireAfterSeconds).toBe(RETENTION.llmUsageLogsDays * 86_400);
    expect(auditIndexes.find((i) => i.expireAfterSeconds !== undefined)?.expireAfterSeconds).toBe(RETENTION.auditLogsDays * 86_400);
  });

  it("enforces unique application slugs per brand only", async () => {
    const a = await repos.brands.getBySlug("brand-a");
    const b = await repos.brands.getBySlug("brand-b");
    await repos.applications.create(a._id.toString(), { slug: "web", name: "A web", kind: "web" });
    await expect(repos.applications.create(a._id.toString(), { slug: "web", name: "dup", kind: "web" })).rejects.toMatchObject({ code: "conflict" });
    expect((await repos.applications.listForBrand(b._id.toString())).map((app) => app.slug)).toEqual(["web"]);
  });
});
