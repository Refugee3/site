import { describe, expect, it } from "vitest";
import * as z from "zod";
import { AppError } from "@/lib/errors";
import { formFields, parseInput } from "@/lib/http/validation";

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected a validation failure");
}

describe("parseInput", () => {
  const Schema = z.object({ title: z.string().min(1, "Give it a title."), items: z.array(z.object({ points: z.number() })) });

  it("returns the parsed value", () => {
    expect(parseInput(Schema, { title: "Quiz", items: [{ points: 1 }], extra: true })).toEqual({ title: "Quiz", items: [{ points: 1 }] });
  });

  it("keys field errors by dotted path", () => {
    const error = failure(() => parseInput(Schema, { title: "", items: [{ points: 1 }, { points: "2" }] }));
    expect(error.code).toBe("validation");
    expect(error.message).toBe("Some fields need fixing.");
    expect(Object.keys(error.extra.fieldErrors ?? {})).toEqual(["title", "items.1.points"]);
    expect(error.extra.fieldErrors?.title).toEqual(["Give it a title."]);
  });

  it("uses a scalar's own message, since there is no field to point at", () => {
    const error = failure(() => parseInput(z.number().int("Use whole numbers."), 1.5));
    expect(error.message).toBe("Use whole numbers.");
    expect(error.extra.fieldErrors).toEqual({});
  });
});

describe("formFields", () => {
  it("reads text fields and leaves missing ones (or files) undefined", () => {
    const fd = new FormData();
    fd.append("title", "Quiz");
    fd.append("upload", new File(["x"], "x.txt"));
    expect(formFields(fd, ["title", "upload", "missing"])).toEqual({ title: "Quiz", upload: undefined, missing: undefined });
  });
});
