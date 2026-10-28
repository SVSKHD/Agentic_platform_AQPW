import { Schema, type Connection, type InferSchemaType, type Model, Types } from "mongoose";
import { ROLES, SCOPES } from "@uap/shared-types";

const DAY_SECONDS = 24 * 60 * 60;

// Retention (spec §3). Change here, then document in docs/architecture.md.
export const RETENTION = {
  llmUsageLogsDays: 400,
  auditLogsDays: 730,
} as const;

// ---------- brands ----------
const brandSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    website: { type: String, trim: true },
    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
    branding: {
      primaryColor: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
      secondaryColor: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
      logoUrl: String,
    },
    contentFocus: { type: [String], default: [] },
    /** Model ids are configuration, never hardcoded in code (spec §20.12). */
    defaultModel: String,
    budgets: {
      dailyTokenLimit: { type: Number, min: 0 },
      monthlyTokenLimit: { type: Number, min: 0 },
      dailyCostLimitUsd: { type: Number, min: 0 },
      monthlyCostLimitUsd: { type: Number, min: 0 },
    },
  },
  { timestamps: true, collection: "brands" },
);

// ---------- applications ----------
const applicationSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },
    slug: { type: String, required: true, lowercase: true, trim: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: ["web", "mobile", "backend", "internal"], required: true },
    /** Public identifier a frontend sends in X-UAP-App. Not a secret. */
    publishableKey: { type: String, required: true, unique: true },
    allowedOrigins: { type: [String], default: [] },
    auth: {
      provider: { type: String, enum: ["firebase", "jwt", "none"], default: "none" },
      firebaseProjectId: String,
      jwtIssuer: String,
      jwtAudience: String,
      /** JWKS endpoint for asymmetric JWTs. Shared secrets are never stored here. */
      jwksUrl: String,
      /** Registered resolver that reads the brand's own user roles (e.g. "pawsattva-firestore"). */
      roleSource: { type: String, default: "none" },
    },
    anonymous: {
      enabled: { type: Boolean, default: false },
      dailyMessageLimit: { type: Number, default: 0, min: 0 },
    },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
  },
  { timestamps: true, collection: "applications" },
);
applicationSchema.index({ brandId: 1, slug: 1 }, { unique: true });

// ---------- api_clients ----------
const apiClientSchema = new Schema(
  {
    /** null = platform-level client (only valid with platform:admin). */
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", default: null, index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", default: null },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    keyId: { type: String, required: true, unique: true },
    /** HMAC-SHA256(pepper, secret). The plaintext key is shown once at creation and never stored. */
    keyHash: { type: String, required: true, select: false },
    scopes: { type: [String], enum: SCOPES, default: [] },
    roles: { type: [String], enum: ROLES, default: ["service"] },
    status: { type: String, enum: ["active", "revoked"], default: "active" },
    expiresAt: Date,
    lastUsedAt: Date,
    revokedAt: Date,
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "api_clients" },
);

// ---------- llm_usage_logs ----------
const llmUsageLogSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", default: null },
    agentId: String,
    sessionId: String,
    requestId: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    /** As reported by the provider; null when the provider does not report cost. */
    costUsd: { type: Number, default: null },
    latencyMs: { type: Number, required: true },
    status: { type: String, enum: ["success", "error"], required: true },
    errorCode: String,
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: "llm_usage_logs", versionKey: false },
);
llmUsageLogSchema.index({ brandId: 1, createdAt: -1 });
llmUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION.llmUsageLogsDays * DAY_SECONDS });

// ---------- audit_logs ----------
const auditLogSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    actorKind: { type: String, required: true },
    actorId: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    /** Keep PII out of metadata (spec §13). */
    metadata: { type: Schema.Types.Mixed, default: {} },
    requestId: String,
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: "audit_logs", versionKey: false },
);
auditLogSchema.index({ brandId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION.auditLogsDays * DAY_SECONDS });

export type BrandDoc = InferSchemaType<typeof brandSchema> & { _id: Types.ObjectId };
export type ApplicationDoc = InferSchemaType<typeof applicationSchema> & { _id: Types.ObjectId };
export type ApiClientDoc = InferSchemaType<typeof apiClientSchema> & { _id: Types.ObjectId };
export type LlmUsageLogDoc = InferSchemaType<typeof llmUsageLogSchema> & { _id: Types.ObjectId };
export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & { _id: Types.ObjectId };

export interface Models {
  Brand: Model<BrandDoc>;
  Application: Model<ApplicationDoc>;
  ApiClient: Model<ApiClientDoc>;
  LlmUsageLog: Model<LlmUsageLogDoc>;
  AuditLog: Model<AuditLogDoc>;
}

/** Binds all schemas to one connection. Call once per connection. */
export const createModels = (connection: Connection): Models => ({
  Brand: connection.model<BrandDoc>("Brand", brandSchema),
  Application: connection.model<ApplicationDoc>("Application", applicationSchema),
  ApiClient: connection.model<ApiClientDoc>("ApiClient", apiClientSchema),
  LlmUsageLog: connection.model<LlmUsageLogDoc>("LlmUsageLog", llmUsageLogSchema),
  AuditLog: connection.model<AuditLogDoc>("AuditLog", auditLogSchema),
});

export const isObjectId = (value: string): boolean => Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value;
