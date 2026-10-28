import type { AppConfig } from "@uap/config";
import type { Authenticator } from "@uap/auth";
import type { Logger } from "@uap/core";
import type { Repositories } from "@uap/database";
import type { LlmGateway } from "@uap/llm-gateway";
import type { Principal } from "@uap/shared-types";

/** Everything the HTTP layer needs. Built by runtime.ts in production and by tests directly. */
export interface ApiDeps {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  authenticate: Authenticator;
  gateway: LlmGateway;
  health: {
    mongo: () => Promise<void>;
    redis: () => Promise<void>;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** null when no credentials were sent. Set in the onRequest hook. */
    principal: Principal | null;
  }
}
