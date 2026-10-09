import { describe, expect, it } from "vitest";
import { instructionsField } from "./assignment-form-text";

describe("instructionsField", () => {
  it("promises the upload page only while students can upload", () => {
    expect(instructionsField(true)).toEqual({
      label: "Instructions for students (optional)", hint: "Shown on the upload page, under the title. The grader reads them too.",
    });
    expect(instructionsField(false)).toEqual({
      label: "Instructions the students were given (optional)", hint: "The grader reads these with each paper.",
    });
    expect(instructionsField(false).hint).not.toContain("upload page");
  });
});
