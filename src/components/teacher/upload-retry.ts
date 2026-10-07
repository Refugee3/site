/** Server error codes a file gets again on every try: nothing about the file or the assignment changes on a retry. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "duplicate",
  "is_answer_key",
  "invalid_pdf",
  "encrypted_pdf",
  "too_many_pages",
  "not_pdf",
  "empty_pdf",
  "too_large",
  "unsupported_type",
]);

/**
 * Whether another try of a failed upload can succeed. `code` is the server's error code, or null when no
 * usable answer came back (a network error, a cancelled upload, an unexpected reply). Network and server
 * trouble, rate limits, an unapproved key and an expired session can clear up; a duplicate, the answer key
 * itself or a file that isn't a usable PDF cannot.
 */
export function isRetryable(code: string | null): boolean {
  return code === null || !PERMANENT_CODES.has(code);
}

/** The error code of a failed upload; a proxy's bodiless 413 still means the file is too large. */
export function uploadErrorCode(status: number, code: string | null): string | null {
  return code ?? (status === 413 ? "too_large" : null);
}
