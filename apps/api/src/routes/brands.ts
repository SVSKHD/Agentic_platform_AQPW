import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { isPlatformAdmin, requireScopes } from "@uap/auth";
import { forbidden } from "@uap/core";
import type { ApiDeps } from "../deps.js";
import { brandAdminPatchSchema, brandCreateSchema, brandParams, brandSchema, brandSelfPatchSchema, toBrand } from "../schemas.js";
import { loadBrandFor } from "./brand-access.js";

export const brandRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/brands",
      { schema: { tags: ["brands"], description: "Platform admins see all brands; everyone else sees only their own.", response: { 200: z.object({ items: z.array(brandSchema) }) } } },
      async (request) => {
        const principal = requireScopes(request.principal, "brands:read");
        const brands = isPlatformAdmin(principal)
          ? await deps.repos.brands.list()
          : await deps.repos.brands.listByIds(principal.brandId ? [principal.brandId] : []);
        return { items: brands.map(toBrand) };
      },
    );

    app.post(
      "/brands",
      { schema: { tags: ["brands"], body: brandCreateSchema, response: { 201: brandSchema } } },
      async (request, reply) => {
        const principal = requireScopes(request.principal, "platform:admin");
        const brand = await deps.repos.brands.create(request.body);
        await deps.repos.audit.record({
          brandId: brand._id.toString(),
          actorKind: principal.kind,
          actorId: principal.id,
          action: "brand.create",
          targetType: "brand",
          targetId: brand._id.toString(),
          requestId: request.id,
        });
        return reply.status(201).send(toBrand(brand));
      },
    );

    app.get("/brands/:brandSlug", { schema: { tags: ["brands"], params: brandParams, response: { 200: brandSchema } } }, async (request) => {
      const { brand } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "brands:read");
      return toBrand(brand);
    });

    app.patch(
      "/brands/:brandSlug",
      {
        schema: {
          tags: ["brands"],
          description: "Brand admins may edit name, website, branding and contentFocus. status, defaultModel and budgets are platform-admin only.",
          params: brandParams,
          body: brandAdminPatchSchema,
          response: { 200: brandSchema },
        },
      },
      async (request) => {
        const { principal, brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "brands:write");
        if (!isPlatformAdmin(principal)) {
          const allowed = Object.keys(brandSelfPatchSchema.shape);
          const blocked = Object.keys(request.body).filter((key) => !allowed.includes(key));
          if (blocked.length) throw forbidden(`Only platform admins may change: ${blocked.join(", ")}`);
        }
        const brand = await deps.repos.brands.update(request.params.brandSlug, request.body);
        await deps.repos.audit.record({
          brandId,
          actorKind: principal.kind,
          actorId: principal.id,
          action: "brand.update",
          targetType: "brand",
          targetId: brandId,
          metadata: { fields: Object.keys(request.body) },
          requestId: request.id,
        });
        return toBrand(brand);
      },
    );
  };
