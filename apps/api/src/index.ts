import { ConfigError, loadConfig } from "@uap/config";
import { createLogger } from "@uap/core";
import { createRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

const main = async () => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logger is not configured yet; print the config problems plainly and exit.
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel, pretty: config.env === "development", name: "api" });
  const runtime = await createRuntime(config, logger);
  const app = await buildServer(runtime.deps);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    const force = setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close(); // stops accepting connections, waits for in-flight requests
      await runtime.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
};

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
