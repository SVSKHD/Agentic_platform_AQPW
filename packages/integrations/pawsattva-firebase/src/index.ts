import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { RoleResolution, UserRoleResolver } from "@uap/auth";
import type { Role, Scope } from "@uap/shared-types";

// PawSattva owns its users and roles (users/{uid}.admin / role / blacklisted, restrictedEmails).
// The platform only READS them to decide what a PawSattva user may do in the AI layer.
// Mirrors PawSattva's own checks: lib/server/paw-gpt-auth.ts and firebase/firestore.rules.

export const PAWSATTVA_ROLE_SOURCE = "pawsattva-firestore";

/** The subset of the Firestore Admin API used here, so tests can pass a fake. */
export interface FirestoreReader {
  doc(path: string): { get(): Promise<{ exists: boolean; get(field: string): unknown }> };
}

export type PawsattvaRole = "user" | "author" | "admin";

/**
 * What each PawSattva role may do in the platform. Content is still reviewed and published
 * in PawSattva's own admin; these scopes cover platform-side actions (chat, AI drafts,
 * reviewing AI suggestions). Platform administration is never granted to brand users.
 */
export const PAWSATTVA_ROLE_MAP: Record<PawsattvaRole, { roles: Role[]; scopes: Scope[] }> = {
  user: { roles: ["end_user"], scopes: ["chat:use"] },
  author: { roles: ["editor"], scopes: ["chat:use", "content:read", "content:write"] },
  admin: { roles: ["reviewer"], scopes: ["chat:use", "content:read", "content:write", "content:review"] },
};

/** PawSattva's rule: admin == true means staff; role "author" narrows it; anything else is a full admin. */
export const pawsattvaRoleOf = (profile: { get(field: string): unknown }): PawsattvaRole => {
  if (profile.get("admin") !== true) return "user";
  return profile.get("role") === "author" ? "author" : "admin";
};

export const createPawsattvaRoleResolver = (db: FirestoreReader): UserRoleResolver => ({
  async resolve(user): Promise<RoleResolution> {
    const [profile, restricted] = await Promise.all([
      db.doc(`users/${user.subject}`).get(),
      user.email ? db.doc(`restrictedEmails/${user.email}`).get() : Promise.resolve(null),
    ]);
    // PawSattva creates the profile on first sign-in; no profile means a stale or foreign token.
    if (!profile.exists) return { status: "unknown_user" };
    if (profile.get("blacklisted") === true || restricted?.exists) {
      return { status: "blocked", reason: "Your account is restricted." };
    }
    return { status: "ok", ...PAWSATTVA_ROLE_MAP[pawsattvaRoleOf(profile)] };
  },
});

const APP_NAME = "uap-pawsattva";

/** Firestore for PawSattva's project, from the FIREBASE_* service account. One app per process. */
export const pawsattvaFirestore = (credentials: { projectId: string; clientEmail: string; privateKey: string }) => {
  const app: App =
    getApps().find((existing) => existing.name === APP_NAME) ??
    initializeApp({ credential: cert(credentials), projectId: credentials.projectId }, APP_NAME);
  return getFirestore(app);
};
