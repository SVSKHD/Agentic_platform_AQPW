import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError } from "@uap/core";
import { LlmError, llmErrorToAppError } from "@uap/llm-gateway";

/** Every error response has this shape (spec §20.7). */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

const body = (code: string, message: string, requestId: string, details?: unknown): ErrorBody => ({
  error: { code, message, requestId, ...(details !== undefined && { details }) },
});

export const registerErrorHandling = (app: FastifyInstance) => {
  app.setErrorHandler((err: FastifyError | AppError | LlmError | Error, request, reply) => {
    if (err instanceof LlmError) {
      request.log.warn({ llmCode: err.code, provider: err.provider, status: err.status }, "LLM request failed");
      const appErr = llmErrorToAppError(err);
      return reply.status(appErr.statusCode).send(body(appErr.code, appErr.message, request.id, appErr.details));
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) request.log.error({ err }, err.message);
      return reply.status(err.statusCode).send(body(err.code, err.message, request.id, err.details));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send(body("validation_failed", "Request validation failed", request.id, err.validation));
    }
    if (isResponseSerializationError(err)) {
      // Our own response did not match its schema: a server bug, never the caller's fault.
      request.log.error({ err, cause: err.cause }, "Response serialization failed");
      return reply.status(500).send(body("internal", "Internal server error", request.id));
    }
    const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status < 500) {
      return reply.status(status).send(body(status === 429 ? "rate_limited" : "bad_request", err.message, request.id));
    }
    request.log.error({ err }, "Unhandled error");
    return reply.status(500).send(body("internal", "Internal server error", request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(body("not_found", `Route ${request.method} ${request.url} not found`, request.id));
  });
};
