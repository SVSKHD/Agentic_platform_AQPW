import { AppError, type ErrorCode } from "@uap/core";

export type LlmErrorCode =
  | "auth"
  | "bad_request"
  | "rate_limited"
  | "quota_exceeded"
  | "timeout"
  | "cancelled"
  | "provider_unavailable"
  | "content_filtered"
  | "budget_exceeded"
  | "invalid_output"
  | "not_configured"
  | "unknown";

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(["rate_limited", "provider_unavailable", "unknown"]);
/** Errors where trying the next model/provider in the route can help. */
const FALLBACKABLE: ReadonlySet<LlmErrorCode> = new Set(["rate_limited", "provider_unavailable", "quota_exceeded", "unknown"]);

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly fallbackable: boolean;

  constructor(
    readonly code: LlmErrorCode,
    message: string,
    options: { cause?: unknown; status?: number; retryAfterMs?: number; provider?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.retryable = RETRYABLE.has(code);
    this.fallbackable = FALLBACKABLE.has(code);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.provider = options.provider;
  }

  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly provider: string | undefined;
}

const APP_CODE: Record<LlmErrorCode, ErrorCode> = {
  auth: "upstream_error",
  bad_request: "bad_request",
  rate_limited: "rate_limited",
  quota_exceeded: "upstream_error",
  timeout: "upstream_error",
  cancelled: "bad_request",
  provider_unavailable: "upstream_error",
  content_filtered: "bad_request",
  budget_exceeded: "budget_exceeded",
  invalid_output: "upstream_error",
  not_configured: "not_configured",
  unknown: "upstream_error",
};

/**
 * Maps to a client-safe AppError. Provider auth failures become a generic upstream error:
 * callers must not learn about our credentials' state.
 */
export const llmErrorToAppError = (err: LlmError): AppError =>
  new AppError(APP_CODE[err.code], err.code === "auth" ? "LLM provider request failed" : err.message, { llmCode: err.code });
