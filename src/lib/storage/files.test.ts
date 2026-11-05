import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { isAppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import {
  ensureDataDirs, pdfResponse, readDataFile, removeAssignmentFiles, removeDataFile, sweepTmp, writeFileAtomic,
} from "@/lib/storage/files";
import { dataDir, keyPdfRel, resolveDataPath, submissionPdfRel } from "@/lib/storage/paths";

const BYTES = new TextEncoder().encode("%PDF-1.4 test bytes");
const tmpDir = () => path.join(dataDir(), "tmp");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureDataDirs", () => {
  it("creates files/ and tmp/ and can run twice", async () => {
    await ensureDataDirs();
    await ensureDataDirs();
    expect(fs.statSync(path.join(dataDir(), "files")).isDirectory()).toBe(true);
    expect(fs.statSync(tmpDir()).isDirectory()).toBe(true);
  });
});

describe("writeFileAtomic and readDataFile", () => {
  it("round-trips bytes through a private file and leaves no staging file behind", async () => {
    const rel = submissionPdfRel(newId(), newId());
    await writeFileAtomic(rel, BYTES);
    const read = await readDataFile(rel);
    expect(read).toBeInstanceOf(Uint8Array);
    expect(Array.from(read)).toEqual(Array.from(BYTES));
    expect(fs.statSync(resolveDataPath(rel)).mode & 0o777 & ~0o640).toBe(0); // never more open than 0o640 (umask may narrow it)
    expect(fs.readdirSync(tmpDir())).toEqual([]);
  });

  it("replaces an existing file", async () => {
    const rel = keyPdfRel(newId(), newId());
    await writeFileAtomic(rel, BYTES);
    await writeFileAtomic(rel, new TextEncoder().encode("second"));
    expect(new TextDecoder().decode(await readDataFile(rel))).toBe("second");
  });

  it("refuses malformed paths before touching the disk", async () => {
    await expect(writeFileAtomic("files/../../evil.pdf", BYTES)).rejects.toThrow();
    await expect(readDataFile("../app.db")).rejects.toThrow();
  });

  it("reports a missing file as file_missing", async () => {
    const error = await readDataFile(submissionPdfRel(newId(), newId())).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("file_missing");
  });
});

describe("removing files", () => {
  it("removes one file and ignores one that is already gone", async () => {
    const rel = submissionPdfRel(newId(), newId());
    await writeFileAtomic(rel, BYTES);
    await removeDataFile(rel);
    expect(fs.existsSync(resolveDataPath(rel))).toBe(false);
    await expect(removeDataFile(rel)).resolves.toBeUndefined();
  });

  it("logs instead of throwing when removal fails", async () => {
    const rel = submissionPdfRel(newId(), newId());
    fs.mkdirSync(resolveDataPath(rel), { recursive: true }); // a directory cannot be removed without `recursive`
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(removeDataFile(rel)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain(rel);
  });

  it("removes every file of an assignment, and nothing else", async () => {
    const [assignmentId, otherId] = [newId(), newId()];
    const keep = submissionPdfRel(otherId, newId());
    await writeFileAtomic(keyPdfRel(assignmentId, newId()), BYTES);
    await writeFileAtomic(submissionPdfRel(assignmentId, newId()), BYTES);
    await writeFileAtomic(keep, BYTES);
    await removeAssignmentFiles(assignmentId);
    expect(fs.existsSync(path.join(dataDir(), "files", assignmentId))).toBe(false);
    expect(fs.existsSync(resolveDataPath(keep))).toBe(true);
    await expect(removeAssignmentFiles(assignmentId)).resolves.toBeUndefined();
  });

  it("refuses a malformed assignment id", async () => {
    await expect(removeAssignmentFiles("..")).rejects.toThrow();
    await expect(removeAssignmentFiles("")).rejects.toThrow();
  });
});

describe("sweepTmp", () => {
  it("removes staging files older than the cutoff only", async () => {
    await ensureDataDirs();
    const old = path.join(tmpDir(), newId());
    const fresh = path.join(tmpDir(), newId());
    fs.writeFileSync(old, "old");
    fs.writeFileSync(fresh, "fresh");
    const nowMs = Date.now();
    fs.utimesSync(old, new Date(nowMs - 7_200_000), new Date(nowMs - 7_200_000));
    setClockForTests(() => nowMs);

    expect(await sweepTmp(3_600_000)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(fresh);
  });

  it("returns 0 when the tmp directory does not exist", async () => {
    fs.rmSync(tmpDir(), { recursive: true, force: true });
    expect(await sweepTmp(0)).toBe(0);
  });
});

describe("pdfResponse", () => {
  it("serves the bytes inline with private, non-sniffable headers", async () => {
    const response = pdfResponse(BYTES);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="submission.pdf"',
      "content-length": String(BYTES.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("serves only the view's bytes from a larger buffer", async () => {
    const backing = new TextEncoder().encode("xxxx%PDF-yyyy");
    const response = pdfResponse(backing.subarray(4, 9));
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("%PDF-");
  });
});
