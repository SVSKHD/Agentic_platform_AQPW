import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireScopes } from "@uap/auth";
import { forbidden } from "@uap/core";
import type { ApiDeps } from "../deps.js";

const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string().min(1).max(20_000) }),
  z.object({ role: z.literal("user"), content: z.string().min(1).max(20_000) }),
  z.object({ role: z.literal("assistant"), content: z.string().max(20_000) }),
]);

const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number().nullable(),
});

export const llmRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      "/llm/completions",
      {
        schema: {
          tags: ["llm"],
          description:
            "Server-to-server completion through the gateway. The model comes from the brand's defaultModel or DEFAULT_LLM_MODEL; callers cannot choose arbitrary models. Usage is recorded against the caller's brand.",
          body: z.object({
            messages: z.array(messageSchema).min(1).max(50),
            temperature: z.number().min(0).max(2).optional(),
            maxTokens: z.number().int().min(1).max(8_192).optional(),
          }),
          response: {
            200: z.object({ id: z.string(), model: z.string(), content: z.string().nullable(), finishReason: z.string().nullable(), usage: usageSchema }),
          },
        },
      },
      async (request, reply) => {
        const principal = requireScopes(request.principal, "llm:invoke");
        if (!principal.brandId) throw forbidden("LLM calls must be attributed to a brand; use a brand-scoped API key");
        const brand = await deps.repos.brands.getById(principal.brandId);

        // Cancel the upstream call if the client goes away.
        const controller = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) controller.abort();
        });

        const result = await deps.gateway.chat({
          ...(brand.defaultModel && { route: [{ model: brand.defaultModel }] }),
          messages: request.body.messages,
          ...(request.body.temperature !== undefined && { temperature: request.body.temperature }),
          ...(request.body.maxTokens !== undefined && { maxTokens: request.body.maxTokens }),
          signal: controller.signal,
          context: { brandId: principal.brandId, applicationId: principal.applicationId, requestId: request.id },
        });
        return { id: result.id, model: result.model, content: result.content, finishReason: result.finishReason, usage: result.usage };
      },
    );
  };
