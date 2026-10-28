import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requirePrincipal } from "@uap/auth";

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/auth/me",
    {
      schema: {
        tags: ["auth"],
        description: "Returns the authenticated principal as the server sees it.",
        response: {
          200: z.object({
            kind: z.enum(["api_client", "user", "anonymous"]),
            id: z.string(),
            brandId: z.string().nullable(),
            applicationId: z.string().nullable(),
            scopes: z.array(z.string()),
            roles: z.array(z.string()),
          }),
        },
      },
    },
    async (request) => {
      requirePrincipal(request.principal);
      const { kind, id, brandId, applicationId, scopes, roles } = request.principal;
      return { kind, id, brandId, applicationId, scopes: [...scopes], roles: [...roles] };
    },
  );
};
