import { describe, expect, it } from "vitest";
import { FLAG_DEFS, IDENTITY_FLAGS, hasReviewFlag, statusFromFlags } from "@/lib/flags";
import { FLAG_CODES, type FlagCode } from "@/lib/types";

const INFO_FLAGS: FlagCode[] = ["name_uncertain", "section_inferred", "fallback_model"];

describe("FLAG_DEFS", () => {
  it("marks exactly the three info flags as info and everything else as review", () => {
    for (const code of FLAG_CODES) {
      expect(FLAG_DEFS[code].severity).toBe(INFO_FLAGS.includes(code) ? "info" : "review");
    }
  });

  it("gives every flag a label and a description", () => {
    for (const code of FLAG_CODES) {
      expect(FLAG_DEFS[code].label.length).toBeGreaterThan(0);
      expect(FLAG_DEFS[code].description).toMatch(/\.$/);
    }
  });

  it("lists the identity flags", () => {
    expect([...IDENTITY_FLAGS].sort()).toEqual(
      ["name_missing", "name_uncertain", "name_unclear", "section_inferred", "section_unmatched"],
    );
  });
});

describe("hasReviewFlag", () => {
  it("is false for no flags or only info flags", () => {
    expect(hasReviewFlag([])).toBe(false);
    expect(hasReviewFlag(INFO_FLAGS)).toBe(false);
  });

  it("is true when any review flag is present", () => {
    expect(hasReviewFlag(["fallback_model", "low_confidence"])).toBe(true);
  });
});

describe("statusFromFlags", () => {
  it.each<[FlagCode[], number | null, "graded" | "needs_review"]>([
    [[], null, "graded"],
    [["name_uncertain", "fallback_model"], null, "graded"],
    [["name_missing"], null, "needs_review"],
    [["ai_refused"], null, "needs_review"],
    [["name_missing"], 1_700_000_000_000, "graded"],
    [[], 1_700_000_000_000, "graded"],
  ])("flags %j, reviewedAt %j → %s", (flags, reviewedAt, expected) => {
    expect(statusFromFlags(flags, reviewedAt)).toBe(expected);
  });
});
