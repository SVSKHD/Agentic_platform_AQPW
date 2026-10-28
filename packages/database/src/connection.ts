import mongoose, { type Connection } from "mongoose";
import { backoffDelay, sleep, type Logger } from "@uap/core";

export interface ConnectOptions {
  uri: string;
  logger: Logger;
  /** Attempts for the *initial* connection. After that the driver reconnects on its own. */
  maxAttempts?: number;
  serverSelectionTimeoutMs?: number;
}

/**
 * Opens a dedicated connection (not the mongoose global) so tests and multiple
 * databases can coexist. Retries the initial connect with backoff; afterwards the
 * MongoDB driver handles reconnection and we only log state changes.
 */
export const connectMongo = async ({
  uri,
  logger,
  maxAttempts = 10,
  serverSelectionTimeoutMs = 5_000,
}: ConnectOptions): Promise<Connection> => {
  const log = logger.child({ component: "mongo" });
  for (let attempt = 0; ; attempt += 1) {
    const connection = mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: serverSelectionTimeoutMs,
      autoIndex: true,
    });
    try {
      await connection.asPromise();
    } catch (err) {
      await connection.close().catch(() => undefined);
      if (attempt + 1 >= maxAttempts) throw err;
      const delay = backoffDelay(attempt, { baseMs: 500, maxMs: 15_000 });
      log.warn({ error: err instanceof Error ? err.message : String(err), attempt: attempt + 1, retryInMs: delay }, "MongoDB connect failed; retrying");
      await sleep(delay);
      continue;
    }
    // Lifecycle listeners only after the first successful connect, so startup retries log once each.
    connection.on("disconnected", () => log.warn("MongoDB disconnected"));
    connection.on("reconnected", () => log.info("MongoDB reconnected"));
    connection.on("error", (err: unknown) => log.error({ err }, "MongoDB connection error"));
    log.info("MongoDB connected");
    return connection;
  }
};

export const pingMongo = async (connection: Connection): Promise<void> => {
  if (!connection.db) throw new Error("MongoDB connection is not open");
  await connection.db.admin().ping();
};
