import { forbidden, unauthenticated } from "@uap/core";
import type { Principal, Scope } from "@uap/shared-types";

export const isPlatformAdmin = (principal: Principal): boolean =>
  principal.kind === "api_client" && principal.scopes.includes("platform:admin");

export const hasScope = (principal: Principal, scope: Scope): boolean =>
  isPlatformAdmin(principal) || principal.scopes.includes(scope);

export function requirePrincipal(principal: Principal | null): asserts principal is Principal {
  if (!principal) throw unauthenticated();
}

export const requireScopes = (principal: Principal | null, ...scopes: Scope[]): Principal => {
  requirePrincipal(principal);
  const missing = scopes.filter((scope) => !hasScope(principal, scope));
  if (missing.length) throw forbidden(`Missing scope(s): ${missing.join(", ")}`);
  return principal;
};

/** Tenant isolation at the service boundary: a principal may only touch its own brand. */
export const assertBrandAccess = (principal: Principal, brandId: string): void => {
  if (isPlatformAdmin(principal)) return;
  if (principal.brandId !== brandId) throw forbidden("You do not have access to this brand");
};
