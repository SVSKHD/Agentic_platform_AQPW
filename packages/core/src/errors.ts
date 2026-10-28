export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "budget_exceeded"
  | "not_configured"
  | "not_implemented"
  | "upstream_error"
  | "internal";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 402,
  not_configured: 503,
  not_implemented: 501,
  upstream_error: 502,
  internal: 500,
};

/** The only error type that may cross an HTTP boundary with its message intact. */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.statusCode = STATUS_BY_CODE[code];
  }
}

export const notFound = (resource: string, id: string) => new AppError("not_found", `${resource} '${id}' not found`);

export const forbidden = (message = "You do not have access to this resource") => new AppError("forbidden", message);

export const unauthenticated = (message = "Authentication required") => new AppError("unauthenticated", message);
