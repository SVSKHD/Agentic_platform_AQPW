import { AppError, forbidden, unauthenticated } from "@uap/core";
import type { Principal, Role, Scope } from "@uap/shared-types";
import { API_KEY_PREFIX, parseApiKey, verifyApiKeySecret } from "./api-keys.js";
import type { AppAuthSettings, UserTokenVerifier, VerifiedUser } from "./token-verifiers.js";

/**
 * Maps a verified user to the roles the *brand's own* system gives them (e.g. PawSattva's
 * admin/author/user). The brand stays the owner of its roles; resolvers only read them.
 * Implementations live in packages/integrations/* and are registered by name.
 */
export type RoleResolution =
  | { status: "ok"; roles: Role[]; scopes: Scope[] }
  | { status: "blocked"; reason: string }
  | { status: "unknown_user" };

export interface UserRoleResolver {
  resolve(user: VerifiedUser): Promise<RoleResolution>;
}

// Structural store interfaces, satisfied by @uap/database repositories. Keeps auth testable without MongoDB.
interface IdLike {
  toString(): string;
}

export interface ApiClientRecord {
  _id: IdLike;
  brandId?: IdLike | null;
  applicationId?: IdLike | null;
  keyHash: string;
  scopes: string[];
  roles: string[];
  expiresAt?: Date | null;
}

export interface ApplicationRecord {
  _id: IdLike;
  brandId: IdLike;
  allowedOrigins: string[];
  auth?: Partial<AppAuthSettings> | null;
  anonymous?: { enabled?: boolean | null } | null;
}

export interface AuthStores {
  findActiveApiClient(keyId: string): Promise<ApiClientRecord | null>;
  touchApiClient(client: ApiClientRecord): Promise<unknown>;
  findActiveApplication(publishableKey: string): Promise<ApplicationRecord | null>;
}

export interface AuthenticatorOptions {
  stores: AuthStores;
  pepper: string;
  verifiers: { firebase: UserTokenVerifier; jwt: UserTokenVerifier };
  /** By name, as referenced from an application's auth.roleSource. */
  roleResolvers?: Record<string, UserRoleResolver>;
  onBackgroundError?: (err: unknown) => void;
  now?: () => Date;
}

export interface AuthRequest {
  authorization?: string | undefined;
  /** X-UAP-App: an application's publishable key. */
  appKey?: string | undefined;
  /** X-UAP-Anonymous-Id: client-generated id for anonymous sessions. */
  anonymousId?: string | undefined;
  origin?: string | undefined;
}

const ANONYMOUS_ID = /^[A-Za-z0-9_-]{16,64}$/;
const END_USER_SCOPES: Scope[] = ["chat:use"];

const bearer = (header?: string): string | undefined => {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
};

/**
 * Resolves the caller. Returns null when no credentials were presented (routes decide
 * whether that is allowed); throws when credentials are presented but invalid.
 */
export const createAuthenticator = ({ stores, pepper, verifiers, roleResolvers = {}, onBackgroundError, now = () => new Date() }: AuthenticatorOptions) => {
  // Fails closed: an app that names a role source never falls back to "plain user" if it is missing.
  const resolveRoles = async (settings: AppAuthSettings, user: VerifiedUser): Promise<{ roles: Role[]; scopes: Scope[] }> => {
    const source = settings.roleSource;
    if (!source || source === "none") return { roles: ["end_user"], scopes: END_USER_SCOPES };
    const resolver = roleResolvers[source];
    if (!resolver) throw new AppError("not_configured", `User role source '${source}' is not configured on this server`);
    const result = await resolver.resolve(user);
    if (result.status === "blocked") throw forbidden(result.reason);
    if (result.status === "unknown_user") throw unauthenticated("Account not found; sign in again");
    return { roles: result.roles, scopes: result.scopes };
  };

  const fromApiKey = async (token: string): Promise<Principal> => {
    const parsed = parseApiKey(token);
    if (!parsed) throw unauthenticated("Malformed API key");
    const client = await stores.findActiveApiClient(parsed.keyId);
    if (!client || !verifyApiKeySecret(pepper, parsed.secret, client.keyHash)) throw unauthenticated("Invalid API key");
    if (client.expiresAt && client.expiresAt <= now()) throw unauthenticated("API key expired");

    const scopes = client.scopes as Scope[];
    const brandId = client.brandId ? client.brandId.toString() : null;
    // A brandless key without platform:admin would be a cross-tenant key with no tenant: refuse it.
    if (brandId === null && !scopes.includes("platform:admin")) throw forbidden("API client has no brand");

    stores.touchApiClient(client).catch((err: unknown) => onBackgroundError?.(err));
    return {
      kind: "api_client",
      id: client._id.toString(),
      brandId,
      applicationId: client.applicationId ? client.applicationId.toString() : null,
      scopes,
      roles: client.roles as Role[],
    };
  };

  const fromApplication = async (req: AuthRequest, appKey: string, token: string | undefined): Promise<Principal> => {
    const app = await stores.findActiveApplication(appKey);
    if (!app) throw unauthenticated("Unknown application");
    if (req.origin && app.allowedOrigins.length > 0 && !app.allowedOrigins.includes(req.origin)) {
      throw forbidden("Origin not allowed for this application");
    }
    const base = { brandId: app.brandId.toString(), applicationId: app._id.toString(), scopes: END_USER_SCOPES, roles: ["end_user"] as Role[] };

    if (token) {
      const settings: AppAuthSettings = { provider: "none", ...app.auth } as AppAuthSettings;
      if (settings.provider === "none") throw unauthenticated("Application does not accept user tokens");
      const verifier = settings.provider === "firebase" ? verifiers.firebase : verifiers.jwt;
      const user = await verifier.verify(token, settings);
      const { roles, scopes } = await resolveRoles(settings, user);
      return { kind: "user", id: `${settings.provider}:${user.subject}`, ...base, roles, scopes };
    }

    if (!app.anonymous?.enabled) throw unauthenticated("Sign-in required for this application");
    if (!req.anonymousId || !ANONYMOUS_ID.test(req.anonymousId)) {
      throw new AppError("bad_request", "X-UAP-Anonymous-Id header (16-64 url-safe chars) is required for anonymous use");
    }
    return { kind: "anonymous", id: `anon:${req.anonymousId}`, ...base };
  };

  return async (req: AuthRequest): Promise<Principal | null> => {
    const token = bearer(req.authorization);
    if (token?.startsWith(API_KEY_PREFIX)) return fromApiKey(token);
    if (req.appKey) return fromApplication(req, req.appKey, token);
    if (token) throw unauthenticated("User tokens must be sent with an X-UAP-App header");
    return null;
  };
};

export type Authenticator = ReturnType<typeof createAuthenticator>;
