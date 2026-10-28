import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { AppError, notFound } from "@uap/core";
import type { Role, Scope } from "@uap/shared-types";
import { isObjectId, type ApiClientDoc, type ApplicationDoc, type BrandDoc, type Models } from "./models.js";

// Tenant isolation rule: every repository method for brand-owned data takes `brandId`
// and puts it in the query filter. Never look up a brand-owned document by `_id` alone.

const toObjectId = (id: string, resource: string): Types.ObjectId => {
  if (!isObjectId(id)) throw notFound(resource, id);
  return new Types.ObjectId(id);
};

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === 11000;

const rethrowDuplicate = (err: unknown, message: string): never => {
  if (isDuplicateKey(err)) throw new AppError("conflict", message);
  throw err;
};

// ---------- brands ----------
export type BrandInput = Pick<BrandDoc, "slug" | "name"> & Partial<Omit<BrandDoc, "_id" | "slug" | "name" | "createdAt" | "updatedAt">>;

export const createBrandRepository = ({ Brand }: Models) => ({
  list: () => Brand.find().sort({ slug: 1 }).lean<BrandDoc[]>(),

  listByIds: (ids: string[]) =>
    Brand.find({ _id: { $in: ids.filter(isObjectId) } }).sort({ slug: 1 }).lean<BrandDoc[]>(),

  findBySlug: (slug: string) => Brand.findOne({ slug }).lean<BrandDoc>(),

  getById: async (id: string): Promise<BrandDoc> => {
    const brand = await Brand.findById(toObjectId(id, "Brand")).lean<BrandDoc>();
    if (!brand) throw notFound("Brand", id);
    return brand;
  },

  getBySlug: async (slug: string): Promise<BrandDoc> => {
    const brand = await Brand.findOne({ slug }).lean<BrandDoc>();
    if (!brand) throw notFound("Brand", slug);
    return brand;
  },

  create: async (input: BrandInput): Promise<BrandDoc> => {
    try {
      return (await Brand.create(input)).toObject<BrandDoc>();
    } catch (err) {
      return rethrowDuplicate(err, `Brand '${input.slug}' already exists`);
    }
  },

  /** Idempotent seed helper: inserts when missing, never overwrites existing values. */
  ensure: async (input: BrandInput): Promise<{ brand: BrandDoc; created: boolean }> => {
    const result = await Brand.findOneAndUpdate(
      { slug: input.slug },
      { $setOnInsert: input },
      { upsert: true, returnDocument: "after", includeResultMetadata: true, lean: true },
    );
    return { brand: result.value as BrandDoc, created: !result.lastErrorObject?.updatedExisting };
  },

  update: async (slug: string, patch: Partial<Omit<BrandInput, "slug">>): Promise<BrandDoc> => {
    const brand = await Brand.findOneAndUpdate({ slug }, { $set: patch }, { returnDocument: "after", runValidators: true }).lean<BrandDoc>();
    if (!brand) throw notFound("Brand", slug);
    return brand;
  },
});

// ---------- applications ----------
export type ApplicationInput = Pick<ApplicationDoc, "slug" | "name" | "kind"> &
  Partial<Pick<ApplicationDoc, "allowedOrigins" | "auth" | "anonymous" | "status">>;

const newPublishableKey = () => `pk_${randomBytes(18).toString("base64url")}`;

export const createApplicationRepository = ({ Application }: Models) => ({
  listForBrand: (brandId: string) =>
    Application.find({ brandId: toObjectId(brandId, "Brand") }).sort({ slug: 1 }).lean<ApplicationDoc[]>(),

  getForBrand: async (brandId: string, id: string): Promise<ApplicationDoc> => {
    const app = await Application.findOne({ _id: toObjectId(id, "Application"), brandId: toObjectId(brandId, "Brand") }).lean<ApplicationDoc>();
    if (!app) throw notFound("Application", id);
    return app;
  },

  create: async (brandId: string, input: ApplicationInput): Promise<ApplicationDoc> => {
    try {
      const doc = await Application.create({ ...input, brandId: toObjectId(brandId, "Brand"), publishableKey: newPublishableKey() });
      return doc.toObject<ApplicationDoc>();
    } catch (err) {
      return rethrowDuplicate(err, `Application '${input.slug}' already exists for this brand`);
    }
  },

  update: async (brandId: string, id: string, patch: Partial<ApplicationInput>): Promise<ApplicationDoc> => {
    const app = await Application.findOneAndUpdate(
      { _id: toObjectId(id, "Application"), brandId: toObjectId(brandId, "Brand") },
      { $set: patch },
      { returnDocument: "after", runValidators: true },
    ).lean<ApplicationDoc>();
    if (!app) throw notFound("Application", id);
    return app;
  },

  /** Auth lookup. The returned brandId is the trusted tenant for the request. */
  findActiveByPublishableKey: (publishableKey: string) =>
    Application.findOne({ publishableKey, status: "active" }).lean<ApplicationDoc>(),
});

// ---------- api_clients ----------
export interface ApiClientInput {
  brandId: string | null;
  applicationId?: string | null;
  name: string;
  keyId: string;
  keyHash: string;
  scopes: Scope[];
  roles: Role[];
  expiresAt?: Date;
  createdBy: string;
}

/** API client as returned to callers: keyHash is never selected. */
export type ApiClientView = Omit<ApiClientDoc, "keyHash">;

export const createApiClientRepository = ({ ApiClient }: Models) => ({
  create: async (input: ApiClientInput): Promise<ApiClientView> => {
    const doc = await ApiClient.create({
      ...input,
      brandId: input.brandId ? toObjectId(input.brandId, "Brand") : null,
      applicationId: input.applicationId ? toObjectId(input.applicationId, "Application") : null,
    });
    const { keyHash: _omit, ...rest } = doc.toObject<ApiClientDoc>();
    return rest;
  },

  listForBrand: (brandId: string) =>
    ApiClient.find({ brandId: toObjectId(brandId, "Brand") }).sort({ createdAt: -1 }).lean<ApiClientView[]>(),

  revokeForBrand: async (brandId: string, id: string): Promise<ApiClientView> => {
    const client = await ApiClient.findOneAndUpdate(
      { _id: toObjectId(id, "API client"), brandId: toObjectId(brandId, "Brand") },
      { $set: { status: "revoked", revokedAt: new Date() } },
      { returnDocument: "after" },
    ).lean<ApiClientView>();
    if (!client) throw notFound("API client", id);
    return client;
  },

  /** Auth lookup; includes keyHash, which is otherwise never selected. */
  findActiveByKeyId: (keyId: string) =>
    ApiClient.findOne({ keyId, status: "active" }).select("+keyHash").lean<ApiClientDoc>(),

  touch: (id: string) => ApiClient.updateOne({ _id: toObjectId(id, "API client") }, { $set: { lastUsedAt: new Date() } }).exec(),
});

// ---------- llm_usage_logs ----------
export interface UsageEntry {
  brandId: string;
  applicationId?: string | null;
  agentId?: string;
  sessionId?: string;
  requestId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  latencyMs: number;
  status: "success" | "error";
  errorCode?: string;
}

export const createUsageRepository = ({ LlmUsageLog }: Models) => ({
  record: async (entry: UsageEntry): Promise<void> => {
    await LlmUsageLog.create({
      ...entry,
      brandId: toObjectId(entry.brandId, "Brand"),
      applicationId: entry.applicationId ? toObjectId(entry.applicationId, "Application") : null,
    });
  },

  totalsSince: async (brandId: string, since: Date): Promise<{ totalTokens: number; costUsd: number }> => {
    const [row] = await LlmUsageLog.aggregate<{ totalTokens: number; costUsd: number }>([
      { $match: { brandId: toObjectId(brandId, "Brand"), createdAt: { $gte: since } } },
      { $group: { _id: null, totalTokens: { $sum: "$totalTokens" }, costUsd: { $sum: { $ifNull: ["$costUsd", 0] } } } },
    ]);
    return { totalTokens: row?.totalTokens ?? 0, costUsd: row?.costUsd ?? 0 };
  },
});

// ---------- audit_logs ----------
export interface AuditEntry {
  brandId: string | null;
  actorKind: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export const createAuditRepository = ({ AuditLog }: Models) => ({
  record: async (entry: AuditEntry): Promise<void> => {
    await AuditLog.create({ ...entry, brandId: entry.brandId ? toObjectId(entry.brandId, "Brand") : null });
  },
});

export type BrandRepository = ReturnType<typeof createBrandRepository>;
export type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
export type ApiClientRepository = ReturnType<typeof createApiClientRepository>;
export type UsageRepository = ReturnType<typeof createUsageRepository>;
export type AuditRepository = ReturnType<typeof createAuditRepository>;

export interface Repositories {
  brands: BrandRepository;
  applications: ApplicationRepository;
  apiClients: ApiClientRepository;
  usage: UsageRepository;
  audit: AuditRepository;
}

export const createRepositories = (models: Models): Repositories => ({
  brands: createBrandRepository(models),
  applications: createApplicationRepository(models),
  apiClients: createApiClientRepository(models),
  usage: createUsageRepository(models),
  audit: createAuditRepository(models),
});
