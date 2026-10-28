import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { generateApiKey, hasScope } from "@uap/auth";
import { forbidden } from "@uap/core";
import type { Role, Scope } from "@uap/shared-types";
import type { ApiDeps } from "../deps.js";
import { apiClientCreateSchema, apiClientParams, apiClientSchema, brandParams, toApiClient } from "../schemas.js";
import { loadBrandFor } from "./brand-access.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const apiClientRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/brands/:brandSlug/api-clients",
      { schema: { tags: ["api-clients"], params: brandParams, response: { 200: z.object({ items: z.array(apiClientSchema) }) } } },
      async (request) => {
        const { brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "api_clients:write");
        return { items: (await deps.repos.apiClients.listForBrand(brandId)).map(toApiClient) };
      },
    );

    app.post(
      "/brands/:brandSlug/api-clients",
      {
        schema: {
          tags: ["api-clients"],
          description: "Creates a brand-scoped API key. The plaintext `apiKey` is returned once and cannot be retrieved again. A caller cannot grant scopes it does not hold.",
          params: brandParams,
          body: apiClientCreateSchema,
          response: { 201: z.object({ client: apiClientSchema, apiKey: z.string() }) },
        },
      },
      async (request, reply) => {
        const { principal, brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "api_clients:write");
        const scopes = request.body.scopes as Scope[];
        // Privilege escalation guard: delegated keys are a subset of the caller's own scopes.
        const escalated = scopes.filter((scope) => !hasScope(principal, scope));
        if (escalated.length) throw forbidden(`Cannot grant scope(s) you do not hold: ${escalated.join(", ")}`);
        if (request.body.applicationId) await deps.repos.applications.getForBrand(brandId, request.body.applicationId);

        const key = generateApiKey(deps.config.apiKeyPepper);
        const client = await deps.repos.apiClients.create({
          brandId,
          applicationId: request.body.applicationId ?? null,
          name: request.body.name,
          keyId: key.keyId,
          keyHash: key.keyHash,
          scopes,
          roles: request.body.roles as Role[],
          ...(request.body.expiresInDays && { expiresAt: new Date(Date.now() + request.body.expiresInDays * DAY_MS) }),
          createdBy: `${principal.kind}:${principal.id}`,
        });
        await deps.repos.audit.record({
          brandId,
          actorKind: principal.kind,
          actorId: principal.id,
          action: "api_client.create",
          targetType: "api_client",
          targetId: client._id.toString(),
          metadata: { scopes },
          requestId: request.id,
        });
        return reply.status(201).send({ client: toApiClient(client), apiKey: key.plaintext });
      },
    );

    app.post(
      "/brands/:brandSlug/api-clients/:clientId/revoke",
      { schema: { tags: ["api-clients"], params: apiClientParams, response: { 200: apiClientSchema } } },
      async (request) => {
        const { principal, brandId } = await loadBrandFor(deps, request.principal, request.params.brandSlug, "api_clients:write");
        const client = await deps.repos.apiClients.revokeForBrand(brandId, request.params.clientId);
        await deps.repos.audit.record({
          brandId,
          actorKind: principal.kind,
          actorId: principal.id,
          action: "api_client.revoke",
          targetType: "api_client",
          targetId: request.params.clientId,
          requestId: request.id,
        });
        return toApiClient(client);
      },
    );
  };
