import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { newId } from "@/lib/ids";
import { dataDir, keyPdfRel, resolveDataPath, scanPdfRel, submissionPdfRel } from "@/lib/storage/paths";

const A = "0b6f2a52-9c1e-4c55-9d3e-2f7b1c9a8e01";
const S = "6a1d0c3e-7b2f-4e8a-b5c4-3d2e1f0a9b87";

describe("data paths", () => {
  it("lives in the configured data directory", () => {
    expect(dataDir()).toBe(getConfig().dataDir);
    expect(path.isAbsolute(dataDir())).toBe(true);
  });

  it("builds relative paths for submission, key and scan PDFs", () => {
    expect(submissionPdfRel(A, S)).toBe(`files/${A}/submissions/${S}.pdf`);
    expect(keyPdfRel(A, S)).toBe(`files/${A}/key/${S}.pdf`);
    expect(scanPdfRel(A, S)).toBe(`files/${A}/scans/${S}.pdf`);
  });

  it("resolves well-formed paths inside the data directory", () => {
    const [assignmentId, fileId] = [newId(), newId()];
    expect(resolveDataPath(submissionPdfRel(assignmentId, fileId)))
      .toBe(path.join(dataDir(), "files", assignmentId, "submissions", `${fileId}.pdf`));
    expect(resolveDataPath(keyPdfRel(assignmentId, fileId))).toBe(path.join(dataDir(), "files", assignmentId, "key", `${fileId}.pdf`));
    expect(resolveDataPath(scanPdfRel(assignmentId, fileId))).toBe(path.join(dataDir(), "files", assignmentId, "scans", `${fileId}.pdf`));
  });

  it.each([
    "../app.db",
    "files/../../etc/passwd",
    `files/${A}/submissions/../../../../etc/passwd.pdf`,
    `files/${A}/submissions/${S}.pdf/../../x.pdf`,
    `/files/${A}/key/${S}.pdf`,
    `${"/tmp"}/files/${A}/key/${S}.pdf`,
    `files/${A}/other/${S}.pdf`,
    `files/${A}/scan/${S}.pdf`,
    `files/${A}/scans/../key/${S}.pdf`,
    `files/${A}/key/${S}.PDF`,
    `files/${A.toUpperCase()}/key/${S}.pdf`,
    `files/${A}/key/${S}.pdf\n`,
    `files/${A}\\key\\${S}.pdf`,
    "",
  ])("refuses %j", (rel) => {
    expect(() => resolveDataPath(rel)).toThrow();
  });
});
