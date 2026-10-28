// Background worker process. Runs separately from the API so heavy jobs (rendering,
// generation) never block live chat (spec §11). Phase 1 only proves the plumbing:
// it connects to Redis and MongoDB and processes the `maintenance` queue.
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { ConfigError, loadConfig } from "@uap/config";
import { createLogger } from "@uap/core";
import { connectMongo, pingMongo } from "@uap/database";

export const MAINTENANCE_QUEUE = "maintenance";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, pretty: config.env === "development", name: "worker" });
const mongo = await connectMongo({ uri: config.mongodbUri, logger });
// BullMQ requires maxRetriesPerRequest: null on worker connections.
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
connection.on("error", (err) => logger.error({ err, component: "redis" }, "Redis error"));

const worker = new Worker(
  MAINTENANCE_QUEUE,
  async (job: Job) => {
    switch (job.name) {
      case "ping":
        await pingMongo(mongo);
        return { ok: true, at: new Date().toISOString() };
      default:
        throw new Error(`Unknown maintenance job '${job.name}'`);
    }
  },
  { connection, concurrency: config.workerConcurrency },
);

worker.on("ready", () => logger.info({ queue: MAINTENANCE_QUEUE, concurrency: config.workerConcurrency }, "Worker ready"));
worker.on("failed", (job, err) => logger.error({ jobId: job?.id, name: job?.name, err }, "Job failed"));
worker.on("error", (err) => logger.error({ err }, "Worker error"));

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Worker shutting down; waiting for active jobs");
  try {
    await worker.close(); // waits for in-flight jobs to finish
    await connection.quit();
    await mongo.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Error during worker shutdown");
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
