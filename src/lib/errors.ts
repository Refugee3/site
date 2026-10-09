export type AppErrorCode = "unauthorized" | "forbidden" | "not_found" | "validation" | "invalid_state" | "conflict" | "closed"
  | "duplicate" | "too_large" | "unsupported_type" | "not_pdf" | "invalid_pdf" | "encrypted_pdf" | "too_many_pages" | "empty_pdf"
  | "is_answer_key" | "key_locked" | "key_not_ready" | "submission_limit" | "rate_limited" | "signup_closed"
  | "bad_signup_code" | "invalid_credentials" | "file_missing" | "internal";

export const ERROR_STATUS: Record<AppErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, validation: 400, invalid_state: 409, conflict: 409, closed: 403,
  duplicate: 409, too_large: 413, unsupported_type: 415, not_pdf: 422, invalid_pdf: 422, encrypted_pdf: 422, too_many_pages: 422,
  empty_pdf: 400, is_answer_key: 422, key_locked: 409, key_not_ready: 409, submission_limit: 409, rate_limited: 429,
  signup_closed: 403, bad_signup_code: 403, invalid_credentials: 401, file_missing: 500, internal: 500,
};

export interface AppErrorExtra {
  status?: number;
  retryAfterMs?: number;
  fieldErrors?: Record<string, string[]>;
}

/** An expected failure whose `message` is safe to show to end users. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly extra: AppErrorExtra = {},
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return this.extra.status ?? ERROR_STATUS[this.code];
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
