import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),

  // HMAC key for API key hashing. A database leak alone must not allow key verification.
  API_KEY_PEPPER: z.string().min(32, "API_KEY_PEPPER must be at least 32 characters"),
  CORS_ALLOWED_ORIGINS: optionalString,

  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_APP_URL: optionalString,
  OPENROUTER_APP_NAME: optionalString,
  DEFAULT_LLM_MODEL: optionalString,
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(16),

  // Owner rule (2026-10-25): an agent job fails at most 2 times, then stops and goes to the dead-letter queue.
  // Attempts = total runs including the first. Capped at 2; it can only be lowered.
  AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2, "AGENT_MAX_ATTEMPTS is capped at 2 by owner rule").default(2),

  FIREBASE_PROJECT_ID: optionalString,
  FIREBASE_CLIENT_EMAIL: optionalString,
  FIREBASE_PRIVATE_KEY: optionalString,

  // AquaKart content is written straight to its MongoDB (owner decision 2026-10-25).
  // Use a dedicated least-privilege user; see docs/integrations/aquakart.md.
  AQUAKART_MONGODB_URI: optionalString,

  // SEO cycle (owner decision 2026-10-25): suggestions land SEO_SUGGESTION_LEAD_DAYS before the
  // SEO_CYCLE_DAYS deadline so reviewers have time to approve. Per-brand overrides come in Phase 3.
  SEO_CYCLE_DAYS: z.coerce.number().int().min(2).max(90).default(10),
  SEO_SUGGESTION_LEAD_DAYS: z.coerce.number().int().min(1).max(30).default(1),

  // Self-hosted MoneyPrinterTurbo, the reel render provider (internal network only).
  MONEYPRINTER_BASE_URL: optionalString,
  MONEYPRINTER_API_KEY: optionalString,

  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_ACCESS_TOKEN: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  JWT_ISSUER: optionalString,
  JWT_AUDIENCE: optionalString,
});

type RawEnv = z.infer<typeof envSchema>;

/** Integration groups are all-or-nothing: a partial group is a configuration error, not "disabled". */
const GROUPS = {
  openrouter: ["OPENROUTER_API_KEY"],
  firebase: ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"],
  aquakartMongo: ["AQUAKART_MONGODB_URI"],
  moneyprinter: ["MONEYPRINTER_BASE_URL", "MONEYPRINTER_API_KEY"],
  meta: ["META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN"],
  s3: ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
} as const satisfies Record<string, ReadonlyArray<keyof RawEnv>>;

export type IntegrationName = keyof typeof GROUPS;

const groupState = (raw: RawEnv, keys: ReadonlyArray<keyof RawEnv>) => {
  const present = keys.filter((key) => raw[key] !== undefined);
  return { complete: present.length === keys.length, partial: present.length > 0 && present.length < keys.length, missing: keys.filter((k) => raw[k] === undefined) };
};

export interface AppConfig {
  env: RawEnv["NODE_ENV"];
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: RawEnv["LOG_LEVEL"];
  mongodbUri: string;
  redisUrl: string;
  workerConcurrency: number;
  apiKeyPepper: string;
  corsAllowedOrigins: string[];
  llm: {
    defaultModel: string | undefined;
    timeoutMs: number;
    maxRetries: number;
    maxConcurrency: number;
  };
  agents: {
    /** Total attempts per agent job (first run + retries). Max 2. */
    maxAttempts: number;
  };
  seoCycle: {
    /** Deadline: SEO changes are due every cycleDays. */
    cycleDays: number;
    /** Suggestions are generated this many days before the deadline (day 9 of 10 by default). */
    suggestionLeadDays: number;
  };
  openrouter?: { apiKey: string; baseUrl: string; appUrl?: string; appName?: string };
  firebase?: { projectId: string; clientEmail: string; privateKey: string };
  aquakartMongo?: { uri: string };
  moneyprinter?: { baseUrl: string; apiKey: string };
  meta?: { appId: string; appSecret: string; accessToken: string };
  s3?: { endpoint: string; region: string | undefined; bucket: string; accessKeyId: string; secretAccessKey: string };
  jwt: { issuer: string | undefined; audience: string | undefined };
  /** Which optional integrations are fully configured. Used by readiness checks. */
  integrations: Record<IntegrationName, boolean>;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const raw = parsed.data;
  const issues: string[] = [];

  const integrations = {} as Record<IntegrationName, boolean>;
  for (const [name, keys] of Object.entries(GROUPS) as [IntegrationName, ReadonlyArray<keyof RawEnv>][]) {
    const state = groupState(raw, keys);
    if (state.partial) issues.push(`${name} is partially configured; missing ${state.missing.join(", ")}`);
    integrations[name] = state.complete;
  }

  const corsAllowedOrigins = (raw.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const isProduction = raw.NODE_ENV === "production";
  if (isProduction || raw.NODE_ENV === "staging") {
    if (corsAllowedOrigins.includes("*")) issues.push("CORS_ALLOWED_ORIGINS must not contain '*' outside development");
    if (raw.LOG_LEVEL === "trace" || raw.LOG_LEVEL === "debug") issues.push("LOG_LEVEL debug/trace is not allowed outside development");
  }
  if (raw.SEO_SUGGESTION_LEAD_DAYS >= raw.SEO_CYCLE_DAYS) issues.push("SEO_SUGGESTION_LEAD_DAYS must be smaller than SEO_CYCLE_DAYS");
  if (integrations.aquakartMongo && raw.AQUAKART_MONGODB_URI === raw.MONGODB_URI) {
    issues.push("AQUAKART_MONGODB_URI must not be the platform database (MONGODB_URI)");
  }

  if (issues.length) throw new ConfigError(issues);

  // Values below are guaranteed by the group checks above; `as string` documents that, it does not bypass a check.
  return {
    env: raw.NODE_ENV,
    isProduction,
    host: raw.HOST,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    mongodbUri: raw.MONGODB_URI,
    redisUrl: raw.REDIS_URL,
    workerConcurrency: raw.WORKER_CONCURRENCY,
    apiKeyPepper: raw.API_KEY_PEPPER,
    corsAllowedOrigins,
    llm: {
      defaultModel: raw.DEFAULT_LLM_MODEL,
      timeoutMs: raw.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: raw.LLM_MAX_RETRIES,
      maxConcurrency: raw.LLM_MAX_CONCURRENCY,
    },
    agents: { maxAttempts: raw.AGENT_MAX_ATTEMPTS },
    seoCycle: { cycleDays: raw.SEO_CYCLE_DAYS, suggestionLeadDays: raw.SEO_SUGGESTION_LEAD_DAYS },
    ...(integrations.openrouter && {
      openrouter: {
        apiKey: raw.OPENROUTER_API_KEY as string,
        baseUrl: raw.OPENROUTER_BASE_URL,
        ...(raw.OPENROUTER_APP_URL && { appUrl: raw.OPENROUTER_APP_URL }),
        ...(raw.OPENROUTER_APP_NAME && { appName: raw.OPENROUTER_APP_NAME }),
      },
    }),
    ...(integrations.firebase && {
      firebase: {
        projectId: raw.FIREBASE_PROJECT_ID as string,
        clientEmail: raw.FIREBASE_CLIENT_EMAIL as string,
        // Env files usually carry the key with literal "\n" sequences.
        privateKey: (raw.FIREBASE_PRIVATE_KEY as string).replace(/\\n/g, "\n"),
      },
    }),
    ...(integrations.aquakartMongo && { aquakartMongo: { uri: raw.AQUAKART_MONGODB_URI as string } }),
    ...(integrations.moneyprinter && {
      moneyprinter: { baseUrl: raw.MONEYPRINTER_BASE_URL as string, apiKey: raw.MONEYPRINTER_API_KEY as string },
    }),
    ...(integrations.meta && {
      meta: { appId: raw.META_APP_ID as string, appSecret: raw.META_APP_SECRET as string, accessToken: raw.META_ACCESS_TOKEN as string },
    }),
    ...(integrations.s3 && {
      s3: {
        endpoint: raw.S3_ENDPOINT as string,
        region: raw.S3_REGION,
        bucket: raw.S3_BUCKET as string,
        accessKeyId: raw.S3_ACCESS_KEY_ID as string,
        secretAccessKey: raw.S3_SECRET_ACCESS_KEY as string,
      },
    }),
    jwt: { issuer: raw.JWT_ISSUER, audience: raw.JWT_AUDIENCE },
    integrations,
  };
};
