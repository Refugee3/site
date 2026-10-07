import { describe, expect, it } from "vitest";
import { isRetryable, uploadErrorCode } from "./upload-retry";

describe("isRetryable", () => {
  it("does not retry what the same file gets again every time", () => {
    for (const code of ["duplicate", "is_answer_key", "invalid_pdf", "encrypted_pdf", "too_many_pages", "not_pdf", "empty_pdf", "too_large", "unsupported_type"]) {
      expect(isRetryable(code), code).toBe(false);
    }
  });

  it("retries network errors, server trouble and states the teacher can fix", () => {
    expect(isRetryable(null)).toBe(true);
    for (const code of ["internal", "file_missing", "rate_limited", "key_not_ready", "unauthorized", "closed"]) {
      expect(isRetryable(code), code).toBe(true);
    }
  });
});

describe("uploadErrorCode", () => {
  it("keeps the server's code, and reads a bodiless 413 as too large", () => {
    expect(uploadErrorCode(409, "duplicate")).toBe("duplicate");
    expect(uploadErrorCode(413, null)).toBe("too_large");
    expect(uploadErrorCode(502, null)).toBeNull();
    expect(uploadErrorCode(500, "internal")).toBe("internal");
  });
});
