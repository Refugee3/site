import { describe, expect, it } from "vitest";
import { AppError, ERROR_STATUS, isAppError } from "@/lib/errors";

describe("AppError", () => {
  it("takes its status from the code", () => {
    const error = new AppError("too_large", "That file is too large.");
    expect(error.status).toBe(413);
    expect(error.message).toBe("That file is too large.");
    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
  });

  it("lets extra.status override the code's status and carries retry and field details", () => {
    const error = new AppError("rate_limited", "Slow down.", { status: 503, retryAfterMs: 1500, fieldErrors: { email: ["x"] } });
    expect(error.status).toBe(503);
    expect(error.extra.retryAfterMs).toBe(1500);
    expect(error.extra.fieldErrors).toEqual({ email: ["x"] });
  });

  it("isAppError rejects other errors and non-errors", () => {
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError({ code: "not_found", status: 404 })).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it("maps a few codes to their documented statuses", () => {
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.closed).toBe(403);
    expect(ERROR_STATUS.empty_pdf).toBe(400);
    expect(ERROR_STATUS.unsupported_type).toBe(415);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });
});
