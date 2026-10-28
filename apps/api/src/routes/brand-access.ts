import { assertBrandAccess, requireScopes } from "@uap/auth";
import type { BrandDoc } from "@uap/database";
import type { Principal, Scope } from "@uap/shared-types";
import type { ApiDeps } from "../deps.js";

/**
 * Resolves a brand from the URL and enforces scope + tenant access in one place.
 * Every /brands/:brandSlug/* handler must go through this.
 */
export const loadBrandFor = async (
  deps: ApiDeps,
  principal: Principal | null,
  brandSlug: string,
  ...scopes: Scope[]
): Promise<{ principal: Principal; brand: BrandDoc; brandId: string }> => {
  const authorized = requireScopes(principal, ...scopes);
  const brand = await deps.repos.brands.getBySlug(brandSlug);
  const brandId = brand._id.toString();
  assertBrandAccess(authorized, brandId);
  return { principal: authorized, brand, brandId };
};
