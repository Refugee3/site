import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";

export type AiErrorCode = "refusal" | "max_tokens" | "invalid_output" | "rate_limited" | "overloaded" | "server_error" | "connection"
  | "timeout" | "aborted" | "bad_request" | "request_too_large" | "auth" | "model_not_found" | "not_configured" | "unknown";

export interface AiErrorOptions {
  retryable: boolean;
  retryAfterMs?: number | null;
  /** The whole worker should stop claiming jobs (bad key, unknown model): every job would fail the same way. */
  pauseWorker?: boolean;
  refusalCategory?: string | null;
}

/** A failed AI call, classified so the job layer can decide between retry, pause and fail. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly o: AiErrorOptions,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * Maps anything thrown by an AI call to an AiError (§5.5). Order matters: the SDK's abort and
 * connection errors are subclasses of APIError, so they are matched before the generic cases.
 */
export function classifySdkError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof APIUserAbortError) return new AiError("aborted", e.message, { retryable: true });
  if (e instanceof APIConnectionTimeoutError) return new AiError("timeout", e.message, { retryable: true });
  if (e instanceof APIConnectionError) return new AiError("connection", e.message, { retryable: true });
  if (e instanceof RateLimitError) {
    return new AiError("rate_limited", e.message, { retryable: true, retryAfterMs: retryAfterMs(e.headers) });
  }
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
    return new AiError("auth", e.message, { retryable: false, pauseWorker: true });
  }
  if (e instanceof NotFoundError) return new AiError("model_not_found", e.message, { retryable: false, pauseWorker: true });
  if (e instanceof BadRequestError || e instanceof UnprocessableEntityError) {
    return new AiError("bad_request", e.message, { retryable: false });
  }
  if (e instanceof APIError) return classifyApiError(e);
  if (e instanceof AnthropicError) return new AiError("invalid_output", e.message, { retryable: true });
  return new AiError("unknown", e instanceof Error ? e.message : String(e), { retryable: true });
}

function classifyApiError(e: APIError): AiError {
  // An SSE `error` event after the stream started carries no HTTP status, only the error type (§0 fact 5).
  if (e.status === undefined) {
    const code = e.type === "rate_limit_error" ? "rate_limited" : e.type === "overloaded_error" ? "overloaded" : "server_error";
    return new AiError(code, e.message, { retryable: true });
  }
  if (e.status === 413) return new AiError("request_too_large", e.message, { retryable: false });
  if (e.status === 529) return new AiError("overloaded", e.message, { retryable: true });
  if (e instanceof InternalServerError || e.status >= 500 || e.status === 408 || e.status === 409) {
    return new AiError("server_error", e.message, { retryable: true });
  }
  return new AiError("unknown", e.message, { retryable: false });
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const ms = parseNonNegative(headers?.get("retry-after-ms"));
  if (ms !== null) return Math.ceil(ms);
  const seconds = parseNonNegative(headers?.get("retry-after"));
  return seconds === null ? null : Math.ceil(seconds * 1000);
}

function parseNonNegative(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
