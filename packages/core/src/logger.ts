import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger };

// Paths that must never reach logs (secrets and auth material).
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "*.apiKey",
  "*.password",
  "*.privateKey",
  "*.accessToken",
  "*.token",
  "*.secret",
];

export const createLogger = (options: { level: string; pretty?: boolean; name?: string }): Logger => {
  const config: LoggerOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(options.name ? { name: options.name } : {}),
  };
  if (options.pretty) {
    config.transport = { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" } };
  }
  return pino(config);
};
