import { Redis } from "ioredis";
import type { AppConfig } from "@uap/config";
import { createAuthenticator, FirebaseTokenVerifier, JwksTokenVerifier, type UserRoleResolver, type UserTokenVerifier } from "@uap/auth";
import type { Logger } from "@uap/core";
import { connectMongo, createModels, createRepositories, pingMongo, type Repositories } from "@uap/database";
import { createBudgetGuard, LlmGateway, type LlmProvider } from "@uap/llm-gateway";
import { OpenRouterProvider } from "@uap/openrouter";
import { createPawsattvaRoleResolver, PAWSATTVA_ROLE_SOURCE, pawsattvaFirestore } from "@uap/pawsattva-firebase";
import type { ApiDeps } from "./deps.js";

export interface DepsInput {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  health: ApiDeps["health"];
  /** Overrides for tests. Production uses the real providers built from config. */
  providers?: LlmProvider[];
  verifiers?: { firebase: UserTokenVerifier; jwt: UserTokenVerifier };
  roleResolvers?: Record<string, UserRoleResolver>;
}

const defaultProviders = (config: AppConfig): LlmProvider[] => (config.openrouter ? [new OpenRouterProvider(config.openrouter)] : []);

/** Brand role sources available on this server. Missing credentials = not registered = sign-ins for those apps fail closed. */
const defaultRoleResolvers = (config: AppConfig): Record<string, UserRoleResolver> =>
  config.firebase ? { [PAWSATTVA_ROLE_SOURCE]: createPawsattvaRoleResolver(pawsattvaFirestore(config.firebase)) } : {};

/** The one place the object graph is assembled. Production and tests both go through it. */
export const buildDeps = ({ config, logger, repos, health, providers, verifiers, roleResolvers }: DepsInput): ApiDeps => {
  const gateway = new LlmGateway({
    providers: providers ?? defaultProviders(config),
    ...(config.llm.defaultModel && { defaultRoute: [{ model: config.llm.defaultModel }] }),
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    maxConcurrency: config.llm.maxConcurrency,
    logger,
    usage: {
      record: (event) =>
        repos.usage.record({
          brandId: event.context.brandId,
          applicationId: event.context.applicationId ?? null,
          ...(event.context.agentId && { agentId: event.context.agentId }),
          ...(event.context.sessionId && { sessionId: event.context.sessionId }),
          requestId: event.context.requestId,
          provider: event.provider,
          model: event.model,
          ...event.usage,
          latencyMs: event.latencyMs,
          status: event.status,
          ...(event.errorCode && { errorCode: event.errorCode }),
        }),
    },
    budget: createBudgetGuard({
      getBudget: async (brandId) => (await repos.brands.getById(brandId)).budgets ?? null,
      totalsSince: (brandId, since) => repos.usage.totalsSince(brandId, since),
    }),
  });

  const authenticate = createAuthenticator({
    pepper: config.apiKeyPepper,
    verifiers: verifiers ?? { firebase: new FirebaseTokenVerifier(), jwt: new JwksTokenVerifier() },
    roleResolvers: roleResolvers ?? defaultRoleResolvers(config),
    stores: {
      findActiveApiClient: (keyId) => repos.apiClients.findActiveByKeyId(keyId),
      touchApiClient: (client) => repos.apiClients.touch(client._id.toString()),
      findActiveApplication: (publishableKey) => repos.applications.findActiveByPublishableKey(publishableKey),
    },
    onBackgroundError: (err) => logger.error({ err }, "Failed to update API client lastUsedAt"),
  });

  return { config, logger, repos, authenticate, gateway, health };
};

export interface Runtime {
  deps: ApiDeps;
  close: () => Promise<void>;
}

/** Connects real infrastructure. Resources are closed in reverse order on shutdown. */
export const createRuntime = async (config: AppConfig, logger: Logger): Promise<Runtime> => {
  const mongo = await connectMongo({ uri: config.mongodbUri, logger });
  const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on("error", (err) => logger.error({ err, component: "redis" }, "Redis error"));
  try {
    await redis.connect();
  } catch (err) {
    await mongo.close();
    throw err;
  }
  logger.info({ component: "redis" }, "Redis connected");

  const deps = buildDeps({
    config,
    logger,
    repos: createRepositories(createModels(mongo)),
    health: {
      mongo: () => pingMongo(mongo),
      redis: async () => {
        await redis.ping();
      },
    },
  });

  return {
    deps,
    close: async () => {
      await redis.quit().catch((err: unknown) => logger.error({ err }, "Redis quit failed"));
      await mongo.close();
    },
  };
};
