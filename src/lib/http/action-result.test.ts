import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { attempt, attemptWithData } from "@/lib/http/action-result";

afterEach(() => vi.restoreAllMocks());

describe("attempt", () => {
  it("reports success without passing on what the service returned", async () => {
    expect(await attempt(() => ({ secret: "row" }))).toEqual({ ok: true });
    expect(await attempt(async () => undefined)).toEqual({ ok: true });
  });

  it("maps an AppError to its message and field errors", async () => {
    const fieldErrors = { title: ["Give the assignment a title."] };
    expect(await attempt(() => {
      throw new AppError("validation", "Some fields need fixing.", { fieldErrors });
    })).toEqual({ ok: false, error: "Some fields need fixing.", fieldErrors });
    expect(await attempt(async () => {
      throw new AppError("key_not_ready", "Approve the answer key first.");
    })).toEqual({ ok: false, error: "Approve the answer key first." });
  });

  it("logs anything else without its message and reports it generically", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await attempt(() => {
      throw new Error("Maria Lopez's paper");
    });
    expect(result).toEqual({ ok: false, error: "Something went wrong on the server. Try again." });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).not.toContain("Maria");
  });
});

describe("attemptWithData", () => {
  it("returns the result as data", async () => {
    expect(await attemptWithData(() => ({ count: 3 }))).toEqual({ ok: true, data: { count: 3 } });
  });

  it("fails like attempt", async () => {
    expect(await attemptWithData(() => {
      throw new AppError("invalid_state", "Not now.");
    })).toEqual({ ok: false, error: "Not now." });
  });
});
