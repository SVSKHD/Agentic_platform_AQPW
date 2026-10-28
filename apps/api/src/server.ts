import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { ApiDeps } from "./deps.js";
import { registerErrorHandling } from "./errors.js";
import { apiClientRoutes } from "./routes/api-clients.js";
import { applicationRoutes } from "./routes/applications.js";
import { authRoutes } from "./routes/auth.js";
import { brandRoutes } from "./routes/brands.js";
import { healthRoutes } from "./routes/health.js";
import { llmRoutes } from "./routes/llm.js";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export const buildServer = async (deps: ApiDeps): Promise<FastifyInstance> => {
  const app = Fastify({
    // Widen to Fastify's logger type so the instance keeps default generics.
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Accept a caller's request id only if it looks safe; otherwise mint one.
    genReqId: (req) => {
      const incoming = header(req.headers["x-request-id"]);
      return incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    bodyLimit: 1024 * 1024,
    trustProxy: deps.config.isProduction,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  // JSON API: CSP adds nothing for API responses and would break the docs UI.
  await app.register(helmet, { contentSecurityPolicy: false });
  const origins = deps.config.corsAllowedOrigins;
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.includes("*") || origins.includes(origin)),
    allowedHeaders: ["Authorization", "Content-Type", "X-UAP-App", "X-UAP-Anonymous-Id", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "Unified AI Platform API", version: "0.1.0", description: "See docs/api.md for auth and conventions." },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "API key (uap_sk_...) or a user ID token sent with X-UAP-App" },
          appKey: { type: "apiKey", in: "header", name: "X-UAP-App", description: "Application publishable key (pk_...)" },
        },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    request.principal = await deps.authenticate({
      authorization: header(request.headers.authorization),
      appKey: header(request.headers["x-uap-app"]),
      anonymousId: header(request.headers["x-uap-anonymous-id"]),
      origin: header(request.headers.origin),
    });
  });

  await app.register(healthRoutes(deps));
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(brandRoutes(deps));
      await v1.register(applicationRoutes(deps));
      await v1.register(apiClientRoutes(deps));
      await v1.register(llmRoutes(deps));
    },
    { prefix: "/api/v1" },
  );

  return app;
};
