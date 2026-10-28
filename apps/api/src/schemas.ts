import { z } from "zod";
import { SCOPES } from "@uap/shared-types";
import type { ApiClientView, ApplicationDoc, BrandDoc } from "@uap/database";

// Response schemas double as an allowlist: the serializer drops any field not listed,
// so internal fields (keyHash, __v) can never leak even if a query selects them.

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

export const slugSchema = z.string().regex(/^[a-z0-9-]{2,40}$/, "lowercase letters, digits and hyphens (2-40)");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const brandSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
  branding: z.object({ primaryColor: z.string().nullable(), secondaryColor: z.string().nullable(), logoUrl: z.string().nullable() }),
  contentFocus: z.array(z.string()),
  defaultModel: z.string().nullable(),
  budgets: z.object({
    dailyTokenLimit: z.number().nullable(),
    monthlyTokenLimit: z.number().nullable(),
    dailyCostLimitUsd: z.number().nullable(),
    monthlyCostLimitUsd: z.number().nullable(),
  }),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const toBrand = (doc: BrandDoc): z.infer<typeof brandSchema> => ({
  id: doc._id.toString(),
  slug: doc.slug,
  name: doc.name,
  website: doc.website ?? null,
  status: doc.status,
  branding: {
    primaryColor: doc.branding?.primaryColor ?? null,
    secondaryColor: doc.branding?.secondaryColor ?? null,
    logoUrl: doc.branding?.logoUrl ?? null,
  },
  contentFocus: doc.contentFocus ?? [],
  defaultModel: doc.defaultModel ?? null,
  budgets: {
    dailyTokenLimit: doc.budgets?.dailyTokenLimit ?? null,
    monthlyTokenLimit: doc.budgets?.monthlyTokenLimit ?? null,
    dailyCostLimitUsd: doc.budgets?.dailyCostLimitUsd ?? null,
    monthlyCostLimitUsd: doc.budgets?.monthlyCostLimitUsd ?? null,
  },
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

const budgetsInput = z
  .object({
    dailyTokenLimit: z.number().int().min(0),
    monthlyTokenLimit: z.number().int().min(0),
    dailyCostLimitUsd: z.number().min(0),
    monthlyCostLimitUsd: z.number().min(0),
  })
  .partial();

/** Fields a brand's own admins may edit. */
export const brandSelfPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    website: z.url(),
    branding: z.object({ primaryColor: hexColor, secondaryColor: hexColor, logoUrl: z.url() }).partial(),
    contentFocus: z.array(z.string().trim().min(1)).max(20),
  })
  .partial();

/** Cost and routing controls are platform-admin only. */
export const brandAdminPatchSchema = brandSelfPatchSchema.extend({
  status: z.enum(["active", "disabled"]).optional(),
  defaultModel: z.string().min(1).optional(),
  budgets: budgetsInput.optional(),
});

export const brandCreateSchema = brandAdminPatchSchema.extend({ slug: slugSchema, name: z.string().trim().min(1).max(100) });

// ---------- applications ----------
const appAuthSchema = z.object({
  provider: z.enum(["firebase", "jwt", "none"]),
  firebaseProjectId: z.string().nullable(),
  jwtIssuer: z.string().nullable(),
  jwtAudience: z.string().nullable(),
  jwksUrl: z.string().nullable(),
  roleSource: z.string(),
});

export const applicationSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["web", "mobile", "backend", "internal"]),
  publishableKey: z.string(),
  allowedOrigins: z.array(z.string()),
  auth: appAuthSchema,
  anonymous: z.object({ enabled: z.boolean(), dailyMessageLimit: z.number() }),
  status: z.enum(["active", "disabled"]),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const toApplication = (doc: ApplicationDoc): z.infer<typeof applicationSchema> => ({
  id: doc._id.toString(),
  brandId: doc.brandId.toString(),
  slug: doc.slug,
  name: doc.name,
  kind: doc.kind,
  publishableKey: doc.publishableKey,
  allowedOrigins: doc.allowedOrigins ?? [],
  auth: {
    provider: doc.auth?.provider ?? "none",
    firebaseProjectId: doc.auth?.firebaseProjectId ?? null,
    jwtIssuer: doc.auth?.jwtIssuer ?? null,
    jwtAudience: doc.auth?.jwtAudience ?? null,
    jwksUrl: doc.auth?.jwksUrl ?? null,
    roleSource: doc.auth?.roleSource ?? "none",
  },
  anonymous: { enabled: doc.anonymous?.enabled ?? false, dailyMessageLimit: doc.anonymous?.dailyMessageLimit ?? 0 },
  status: doc.status,
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
});

const origin = z.url().refine((value) => new URL(value).origin === value, "Must be a bare origin like https://example.com");

export const applicationInputSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["web", "mobile", "backend", "internal"]),
    allowedOrigins: z.array(origin).max(20).default([]),
    auth: z
      .object({
        provider: z.enum(["firebase", "jwt", "none"]),
        firebaseProjectId: z.string().min(1).optional(),
        jwtIssuer: z.string().min(1).optional(),
        jwtAudience: z.string().min(1).optional(),
        jwksUrl: z.url().optional(),
        // Must name a resolver registered in runtime.ts; unknown names fail closed at sign-in.
        roleSource: z.enum(["none", "pawsattva-firestore"]).default("none"),
      })
      .default({ provider: "none", roleSource: "none" }),
    anonymous: z.object({ enabled: z.boolean(), dailyMessageLimit: z.number().int().min(0) }).default({ enabled: false, dailyMessageLimit: 0 }),
  })
  .superRefine((value, ctx) => {
    if (value.auth.provider === "firebase" && !value.auth.firebaseProjectId) {
      ctx.addIssue({ code: "custom", path: ["auth", "firebaseProjectId"], message: "Required for firebase auth" });
    }
    if (value.auth.provider === "jwt" && (!value.auth.jwksUrl || !value.auth.jwtIssuer || !value.auth.jwtAudience)) {
      ctx.addIssue({ code: "custom", path: ["auth"], message: "jwt auth needs jwksUrl, jwtIssuer and jwtAudience" });
    }
  });

export const applicationPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    allowedOrigins: z.array(origin).max(20),
    anonymous: z.object({ enabled: z.boolean(), dailyMessageLimit: z.number().int().min(0) }),
    status: z.enum(["active", "disabled"]),
  })
  .partial();

// ---------- api clients ----------
export const apiClientSchema = z.object({
  id: z.string(),
  brandId: z.string().nullable(),
  applicationId: z.string().nullable(),
  name: z.string(),
  keyId: z.string(),
  scopes: z.array(z.string()),
  roles: z.array(z.string()),
  status: z.enum(["active", "revoked"]),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const toApiClient = (doc: ApiClientView): z.infer<typeof apiClientSchema> => ({
  id: doc._id.toString(),
  brandId: doc.brandId ? doc.brandId.toString() : null,
  applicationId: doc.applicationId ? doc.applicationId.toString() : null,
  name: doc.name,
  keyId: doc.keyId,
  scopes: doc.scopes,
  roles: doc.roles,
  status: doc.status,
  expiresAt: iso(doc.expiresAt),
  lastUsedAt: iso(doc.lastUsedAt),
  createdAt: iso(doc.createdAt),
});

export const apiClientCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SCOPES.filter((s) => s !== "platform:admin") as [string, ...string[]])).min(1),
  roles: z.array(z.enum(["brand_admin", "reviewer", "editor", "service"])).default(["service"]),
  applicationId: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(730).optional(),
});

export const brandParams = z.object({ brandSlug: slugSchema });
export const applicationParams = brandParams.extend({ applicationId: z.string().min(1) });
export const apiClientParams = brandParams.extend({ clientId: z.string().min(1) });
