// Bootstrap CLI for API keys (the only way to mint the first platform-admin key).
//   pnpm api-client:create --name ops --platform
//   pnpm api-client:create --name aquakart-backend --brand aquakart --scopes llm:invoke,content:write --expires-days 90
// The plaintext key is printed once. Store it in your secret manager immediately.
import { parseArgs } from "node:util";
import { generateApiKey } from "@uap/auth";
import { loadConfig } from "@uap/config";
import { createLogger } from "@uap/core";
import { connectMongo, createModels, createRepositories } from "@uap/database";
import { SCOPES, type Role, type Scope } from "@uap/shared-types";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    brand: { type: "string" },
    platform: { type: "boolean", default: false },
    scopes: { type: "string" },
    "expires-days": { type: "string" },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!values.name) fail("--name is required");
if (values.platform === Boolean(values.brand)) fail("Pass exactly one of --platform or --brand <slug>");

const scopes = (values.platform ? ["platform:admin"] : (values.scopes ?? "").split(",").map((s) => s.trim()).filter(Boolean)) as Scope[];
const unknown = scopes.filter((scope) => !SCOPES.includes(scope));
if (unknown.length) fail(`Unknown scopes: ${unknown.join(", ")}. Valid: ${SCOPES.join(", ")}`);
if (!values.platform && scopes.length === 0) fail("--scopes is required for brand keys");
if (!values.platform && scopes.includes("platform:admin")) fail("platform:admin is only available with --platform");

const config = loadConfig();
const logger = createLogger({ level: "warn", name: "create-api-client" });
const connection = await connectMongo({ uri: config.mongodbUri, logger, maxAttempts: 3 });
try {
  const repos = createRepositories(createModels(connection));
  const brandId = values.brand ? (await repos.brands.getBySlug(values.brand))._id.toString() : null;
  const key = generateApiKey(config.apiKeyPepper);
  const days = values["expires-days"] ? Number(values["expires-days"]) : undefined;
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) fail("--expires-days must be a positive integer");

  const roles: Role[] = values.platform ? ["platform_admin"] : ["service"];
  const client = await repos.apiClients.create({
    brandId,
    name: values.name as string,
    keyId: key.keyId,
    keyHash: key.keyHash,
    scopes,
    roles,
    ...(days && { expiresAt: new Date(Date.now() + days * 86_400_000) }),
    createdBy: "cli",
  });
  await repos.audit.record({
    brandId,
    actorKind: "cli",
    actorId: "create-api-client",
    action: "api_client.create",
    targetType: "api_client",
    targetId: client._id.toString(),
    metadata: { scopes },
  });
  console.log(`Created API client ${client._id.toString()} (${values.name}) scopes=${scopes.join(",")}`);
  console.log(`\n  ${key.plaintext}\n`);
  console.log("This key is shown once. Store it in your secret manager now.");
} finally {
  await connection.close();
}
