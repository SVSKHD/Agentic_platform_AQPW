import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { unauthenticated } from "@uap/core";

export interface VerifiedUser {
  /** Provider-scoped subject (Firebase uid or JWT `sub`). */
  subject: string;
  /** Lower-cased, when the token carries one. Used for block lists, never stored in logs. */
  email?: string;
  emailVerified?: boolean;
}

export interface AppAuthSettings {
  provider: "firebase" | "jwt" | "none";
  firebaseProjectId?: string | null;
  jwtIssuer?: string | null;
  jwtAudience?: string | null;
  jwksUrl?: string | null;
  /** Name of a registered UserRoleResolver that maps the brand's own user roles. "none" = plain end user. */
  roleSource?: string | null;
}

export interface UserTokenVerifier {
  verify(token: string, settings: AppAuthSettings): Promise<VerifiedUser>;
}

/**
 * Verifies Firebase ID tokens. verifyIdToken only needs the project id (it checks
 * Google's public keys), so no service account is required for this path.
 */
export class FirebaseTokenVerifier implements UserTokenVerifier {
  private readonly apps = new Map<string, App>();

  private appFor(projectId: string): App {
    const name = `uap-verify-${projectId}`;
    const existing = this.apps.get(projectId) ?? getApps().find((app) => app.name === name);
    if (existing) return existing;
    const app = initializeApp({ projectId }, name);
    this.apps.set(projectId, app);
    return app;
  }

  async verify(token: string, settings: AppAuthSettings): Promise<VerifiedUser> {
    if (!settings.firebaseProjectId) throw unauthenticated("Application has no Firebase project configured");
    try {
      const decoded = await getAuth(this.appFor(settings.firebaseProjectId)).verifyIdToken(token);
      return {
        subject: decoded.uid,
        ...(decoded.email && { email: decoded.email.toLowerCase() }),
        ...(decoded.email_verified !== undefined && { emailVerified: decoded.email_verified }),
      };
    } catch {
      throw unauthenticated("Invalid or expired Firebase ID token");
    }
  }
}

/** Verifies asymmetric JWTs against an application's JWKS endpoint. */
export class JwksTokenVerifier implements UserTokenVerifier {
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  async verify(token: string, settings: AppAuthSettings): Promise<VerifiedUser> {
    if (!settings.jwksUrl || !settings.jwtIssuer || !settings.jwtAudience) {
      throw unauthenticated("Application JWT settings are incomplete");
    }
    let keySet = this.keySets.get(settings.jwksUrl);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(settings.jwksUrl));
      this.keySets.set(settings.jwksUrl, keySet);
    }
    try {
      const { payload } = await jwtVerify(token, keySet, { issuer: settings.jwtIssuer, audience: settings.jwtAudience });
      if (!payload.sub) throw new Error("missing sub");
      return { subject: payload.sub, ...(typeof payload.email === "string" && { email: payload.email.toLowerCase() }) };
    } catch {
      throw unauthenticated("Invalid or expired token");
    }
  }
}
