import { describe, expect, it } from "vitest";
import { parseTeacherUploadResult } from "./upload-result";

const TOKEN = "a".repeat(43);

describe("parseTeacherUploadResult", () => {
  it("accepts the documented 201 body", () => {
    const body = { submissionId: "s1", receiptUrl: `https://grader.school.org/r/${TOKEN}` };
    expect(parseTeacherUploadResult(body)).toEqual(body);
    expect(parseTeacherUploadResult({ submissionId: "s1", receiptUrl: `http://localhost:3000/r/${TOKEN}` })).not.toBeNull();
  });

  it("rejects missing fields and anything but an absolute receipt link", () => {
    expect(parseTeacherUploadResult(null)).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "s1" })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: 1, receiptUrl: `https://x.org/r/${TOKEN}` })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "s1", receiptUrl: `/r/${TOKEN}` })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "s1", receiptUrl: `javascript:alert(1)//x/r/${TOKEN}` })).toBeNull();
    expect(parseTeacherUploadResult({ submissionId: "s1", receiptUrl: "https://x.org/r/short" })).toBeNull();
  });
});
