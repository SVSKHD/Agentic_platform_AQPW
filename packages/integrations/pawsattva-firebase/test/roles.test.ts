import { describe, expect, it } from "vitest";
import { createAuthenticator, type ApplicationRecord, type UserTokenVerifier } from "@uap/auth";
import { createPawsattvaRoleResolver, PAWSATTVA_ROLE_SOURCE, type FirestoreReader } from "../src/index.js";

// Fake Firestore holding PawSattva-shaped documents (users/{uid}, restrictedEmails/{email}).
const fakeDb = (docs: Record<string, Record<string, unknown>>): FirestoreReader & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    doc: (path) => ({
      get: async () => {
        reads.push(path);
        const data = docs[path];
        return { exists: Boolean(data), get: (field: string) => data?.[field] };
      },
    }),
  };
};

const db = fakeDb({
  "users/parent": { admin: false, role: "user" },
  "users/writer": { admin: true, role: "author" },
  "users/boss": { admin: true, role: "admin" },
  "users/legacy-admin": { admin: true }, // older profiles have no role field: PawSattva treats them as full admins
  "users/banned": { admin: true, role: "admin", blacklisted: true },
  "users/emailblocked": { admin: false },
  "restrictedEmails/spam@example.com": { reason: "abuse" },
});
const resolver = createPawsattvaRoleResolver(db);

describe("PawSattva role resolver", () => {
  it("maps PawSattva roles to platform roles and scopes", async () => {
    expect(await resolver.resolve({ subject: "parent" })).toEqual({ status: "ok", roles: ["end_user"], scopes: ["chat:use"] });
    expect(await resolver.resolve({ subject: "writer" })).toMatchObject({ status: "ok", roles: ["editor"], scopes: ["chat:use", "content:read", "content:write"] });
    expect(await resolver.resolve({ subject: "boss" })).toMatchObject({ status: "ok", roles: ["reviewer"] });
    expect(await resolver.resolve({ subject: "legacy-admin" })).toMatchObject({ status: "ok", roles: ["reviewer"] });
  });

  it("never grants platform administration to brand users", async () => {
    for (const subject of ["parent", "writer", "boss"]) {
      const result = await resolver.resolve({ subject });
      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.scopes).not.toContain("platform:admin");
      expect(result.scopes).not.toContain("api_clients:write");
      expect(result.scopes).not.toContain("content:publish"); // publishing stays in PawSattva's admin
    }
  });

  it("blocks blacklisted accounts and restricted emails, even admins", async () => {
    expect(await resolver.resolve({ subject: "banned" })).toEqual({ status: "blocked", reason: "Your account is restricted." });
    expect(await resolver.resolve({ subject: "emailblocked", email: "spam@example.com" })).toMatchObject({ status: "blocked" });
  });

  it("rejects tokens with no PawSattva profile", async () => {
    expect(await resolver.resolve({ subject: "ghost" })).toEqual({ status: "unknown_user" });
  });

  it("only reads, and only the two documents it needs", async () => {
    const local = fakeDb({ "users/parent": { admin: false } });
    await createPawsattvaRoleResolver(local).resolve({ subject: "parent", email: "a@b.com" });
    expect(local.reads.sort()).toEqual(["restrictedEmails/a@b.com", "users/parent"]);
  });
});

describe("authenticator with a role source", () => {
  const app = (roleSource: string): ApplicationRecord => ({
    _id: { toString: () => "app1" },
    brandId: { toString: () => "pawsattva-brand" },
    allowedOrigins: [],
    auth: { provider: "firebase", firebaseProjectId: "pawsattva", roleSource },
  });
  const firebase: UserTokenVerifier = { verify: async (token) => ({ subject: token, email: token === "emailblocked" ? "spam@example.com" : undefined }) };
  const build = (roleSource: string, withResolver = true) =>
    createAuthenticator({
      pepper: "p".repeat(32),
      verifiers: { firebase, jwt: firebase },
      ...(withResolver && { roleResolvers: { [PAWSATTVA_ROLE_SOURCE]: resolver } }),
      stores: {
        findActiveApiClient: async () => null,
        touchApiClient: async () => undefined,
        findActiveApplication: async () => app(roleSource),
      },
    });

  it("gives a PawSattva admin reviewer scopes and a pet parent chat only", async () => {
    const authenticate = build(PAWSATTVA_ROLE_SOURCE);
    expect(await authenticate({ appKey: "pk", authorization: "Bearer boss" })).toMatchObject({ kind: "user", roles: ["reviewer"], brandId: "pawsattva-brand" });
    expect(await authenticate({ appKey: "pk", authorization: "Bearer parent" })).toMatchObject({ roles: ["end_user"], scopes: ["chat:use"] });
  });

  it("refuses restricted users", async () => {
    const authenticate = build(PAWSATTVA_ROLE_SOURCE);
    await expect(authenticate({ appKey: "pk", authorization: "Bearer banned" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(authenticate({ appKey: "pk", authorization: "Bearer emailblocked" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(authenticate({ appKey: "pk", authorization: "Bearer ghost" })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("fails closed when the app names a role source the server does not have", async () => {
    await expect(build(PAWSATTVA_ROLE_SOURCE, false)({ appKey: "pk", authorization: "Bearer parent" })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("keeps plain end-user access for apps without a role source", async () => {
    expect(await build("none")({ appKey: "pk", authorization: "Bearer anyone" })).toMatchObject({ roles: ["end_user"], scopes: ["chat:use"] });
  });
});
