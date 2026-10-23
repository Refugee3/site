import { describe, expect, it } from "vitest";
import { parseScanUploadResult } from "./scan-upload-result";

const A = "0b6f6c1e-2d4a-4f8e-9c3b-1a2b3c4d5e6f";
const S = "7e1d2c3b-4a59-4687-b9a0-c1d2e3f4a5b6";

describe("parseScanUploadResult", () => {
  it("accepts the documented 201 body", () => {
    const body = { scanId: S, reviewUrl: `/teacher/assignments/${A}/scans/${S}` };
    expect(parseScanUploadResult(body)).toEqual(body);
  });

  it("keeps only the documented fields", () => {
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `/teacher/assignments/${A}/scans/${S}`, extra: 1 })).toEqual({
      scanId: S,
      reviewUrl: `/teacher/assignments/${A}/scans/${S}`,
    });
  });

  it("rejects missing fields and anything but a scan review path", () => {
    expect(parseScanUploadResult(null)).toBeNull();
    expect(parseScanUploadResult("ok")).toBeNull();
    expect(parseScanUploadResult({ scanId: S })).toBeNull();
    expect(parseScanUploadResult({ reviewUrl: `/teacher/assignments/${A}/scans/${S}` })).toBeNull();
    expect(parseScanUploadResult({ scanId: 1, reviewUrl: `/teacher/assignments/${A}/scans/${S}` })).toBeNull();
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `https://evil.example/teacher/assignments/${A}/scans/${S}` })).toBeNull();
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `//evil.example/teacher/assignments/${A}/scans/${S}` })).toBeNull();
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `/teacher/assignments/${A}/submissions/${S}` })).toBeNull();
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `/teacher/assignments/${A}/scans/${S}?x=1` })).toBeNull();
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `/teacher/assignments/${A}/scans/short` })).toBeNull();
    expect(parseScanUploadResult({ scanId: S, reviewUrl: `/teacher/assignments/../scans/${S}` })).toBeNull();
  });
});
