import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { ApiDeps } from "../deps.js";
import { applicationInputSchema, applicationParams, applicationPatchSchema, applicationSchema, brandParams, toApplication } from "../schemas.js";
import { loadBrandFor } from "./brand-access.js";

export const applicationRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/brands/:brandSlug/applications",
      { schema: { tags: ["applications"], params: brandParams, response: { 200: z.object({ items: z.array(applicationSchema) }) } } },
      async (request) => {
        const { brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "applications:read");
        return { items: (await deps.repos.applications.listForBrand(brandId)).map(toApplication) };
      },
    );

    app.post(
      "/brands/:brandSlug/applications",
      {
        schema: {
          tags: ["applications"],
          description: "Registers a frontend or backend app. The returned publishableKey is public and goes in the X-UAP-App header.",
          params: brandParams,
          body: applicationInputSchema,
          response: { 201: applicationSchema },
        },
      },
      async (request, reply) => {
        const { principal, brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "applications:write");
        const created = await deps.repos.applications.create(brandId, request.body);
        await deps.repos.audit.record({
          brandId,
          actorKind: principal.kind,
          actorId: principal.id,
          action: "application.create",
          targetType: "application",
          targetId: created._id.toString(),
          requestId: request.id,
        });
        return reply.status(201).send(toApplication(created));
      },
    );

    app.get(
      "/brands/:brandSlug/applications/:applicationId",
      { schema: { tags: ["applications"], params: applicationParams, response: { 200: applicationSchema } } },
      async (request) => {
        const { brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "applications:read");
        return toApplication(await deps.repos.applications.getForBrand(brandId, request.params.applicationId));
      },
    );

    app.patch(
      "/brands/:brandSlug/applications/:applicationId",
      { schema: { tags: ["applications"], params: applicationParams, body: applicationPatchSchema, response: { 200: applicationSchema } } },
      async (request) => {
        const { principal, brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "applications:write");
        const updated = await deps.repos.applications.update(brandId, request.params.applicationId, request.body);
        await deps.repos.audit.record({
          brandId,
          actorKind: principal.kind,
          actorId: principal.id,
          action: "application.update",
          targetType: "application",
          targetId: request.params.applicationId,
          metadata: { fields: Object.keys(request.body) },
          requestId: request.id,
        });
        return toApplication(updated);
      },
    );
  };
