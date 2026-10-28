import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { ApiDeps } from "../deps.js";

const CHECK_TIMEOUT_MS = 2_000;

const timed = async (check: () => Promise<void>) => {
  const started = Date.now();
  try {
    await Promise.race([check(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS))]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : "failed" };
  }
};

const checkSchema = z.object({ ok: z.boolean(), latencyMs: z.number(), error: z.string().optional() });

export const healthRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get("/health/live", { schema: { tags: ["health"], response: { 200: z.object({ status: z.literal("ok") }) } } }, async () => ({
      status: "ok" as const,
    }));

    app.get(
      "/health/ready",
      {
        schema: {
          tags: ["health"],
          description: "Dependency checks. Integrations report configured/not configured only; values are never exposed.",
          response: {
            "2xx": z.object({
              status: z.enum(["ok", "degraded"]),
              checks: z.object({ mongo: checkSchema, redis: checkSchema }),
              integrations: z.record(z.string(), z.boolean()),
              llmGateway: z.object({ configured: z.boolean() }),
            }),
          },
        },
      },
      async (_request, reply) => {
        const [mongo, redis] = await Promise.all([timed(deps.health.mongo), timed(deps.health.redis)]);
        const ok = mongo.ok && redis.ok;
        reply.status(ok ? 200 : 503);
        return {
          status: ok ? ("ok" as const) : ("degraded" as const),
          checks: { mongo, redis },
          integrations: deps.config.integrations,
          llmGateway: { configured: deps.gateway.configured },
        };
      },
    );
  };
