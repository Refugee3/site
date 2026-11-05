import { describe, expect, it } from "vitest";
import { parseTeacherUploadResult } from "./upload-result";

describe("parseTeacherUploadResult", () => {
  it("accepts the documented 201 body", () => {
    expect(parseTeacherUploadResult({ submissionId: "0b6f2c9e-4f7a-4c1e-9d55-2a1b3c4d5e6f" })).toEqual({
      submissionId: "0b6f2c9e-4f7a-4c1e-9d55-2a1b3c4d5e6f",
    });
  });

  it("rejects missing fields and ids that couldn't be part of a link", () => {
    expect(parseTeacherUploadResult(null)).toBeNull();
    expect(parseTeacherUploadResult({})).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: 1 })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "" })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "../../teacher/settings" })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "javascript:alert(1)" })).toBeNull();
  });
});
