// Types shared across packages. No runtime dependencies; keep it that way.

/** Seeded brands. New brands are data (brands collection); this list only covers seeds and docs. */
export const SEED_BRAND_SLUGS = ["aquakart", "pawsattva", "spasta"] as const;

export const ROLES = ["platform_admin", "brand_admin", "reviewer", "editor", "service", "end_user"] as const;
export type Role = (typeof ROLES)[number];

/**
 * API scopes. Grant the narrowest set a client needs.
 * `platform:admin` is the only scope that crosses brand boundaries.
 */
export const SCOPES = [
  "platform:admin",
  "brands:read",
  "brands:write",
  "applications:read",
  "applications:write",
  "api_clients:write",
  "llm:invoke",
  "chat:use",
  "content:read",
  "content:write",
  "content:review",
  "content:publish",
  "jobs:manage",
] as const;
export type Scope = (typeof SCOPES)[number];

export type PrincipalKind = "api_client" | "user" | "anonymous";

/** The authenticated caller. Brand and application are always derived server-side, never from client input. */
export interface Principal {
  kind: PrincipalKind;
  /** Stable id: api client id, verified user id, or anonymous session id. */
  id: string;
  /** null only for platform-level API clients holding `platform:admin`. */
  brandId: string | null;
  applicationId: string | null;
  scopes: readonly Scope[];
  roles: readonly Role[];
}

/** Content lifecycle from spec §12. Transitions are enforced by the approval engine (Phase 3). */
export const CONTENT_STATUSES = [
  "DRAFT",
  "GENERATED",
  "VALIDATING",
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}
