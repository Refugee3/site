import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { deleteAssignmentRow } from "@/lib/db/repos/assignments";
import { claimNextJob, completeJob, enqueueJob } from "@/lib/db/repos/jobs";
import {
  deleteScanRow, findScanBySha, getScan, getScanForTeacher, insertScan, listScans, listSplittingScansWithoutJob, recentSplitPageDurations,
  resetCreatingScans,
  updateScan, updateSplittingScan, type NewScan,
} from "@/lib/db/repos/scans";
import { newId } from "@/lib/ids";
import { scanPdfRel } from "@/lib/storage/paths";
import { seedAssignment, seedScan, seedTeacher, useTestDb } from "@/test/helpers";
import type { Assignment, ScanLayout, ScanPageReading, Teacher } from "@/lib/types";

const T0 = 1_700_000_000_000;

const READING: ScanPageReading = {
  kind: "student_work", startsNewPaper: true, studentName: "Maria Lopez", sectionRaw: "P3", pageMarker: "1 of 2", worksheetPage: 1,
  confidence: "high", note: "", reported: true,
};
const LAYOUT: ScanLayout = [
  { startsPaper: true, dropped: false }, { startsPaper: false, dropped: false }, { startsPaper: false, dropped: true },
];

let teacher: Teacher;
let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  teacher = seedTeacher();
  assignment = seedAssignment(teacher.id);
});

function newScan(o: Partial<NewScan> = {}): NewScan {
  const id = o.id ?? newId();
  return {
    id,
    assignmentId: assignment.id,
    status: "splitting",
    splitMode: "auto",
    pagesPerPaper: null,
    pdfPath: scanPdfRel(assignment.id, id),
    originalFilename: "period 3.pdf",
    contentSha256: `sha-${id}`,
    byteSize: 1234,
    pageCount: 3,
    layout: null,
    ...o,
  };
}

describe("insertScan and lookups", () => {
  it("inserts an automatic scan that starts splitting with nothing read", () => {
    const input = newScan();
    const scan = insertScan(input);

    expect(scan).toEqual({
      id: input.id, assignmentId: assignment.id, status: "splitting", splitMode: "auto", pagesPerPaper: null, splitGeneration: 1,
      pdfPath: input.pdfPath, originalFilename: "period 3.pdf", contentSha256: input.contentSha256, byteSize: 1234, pageCount: 3,
      readings: [], pagesRead: 0, layout: null, proposedLayout: null, statusNote: null, errorMessage: null, aiModel: null,
      usage: null, createdCount: null, duplicateCount: null, splitStartedAt: T0, splitFinishedAt: null, autoGraded: false, onePass: null,
      createdAt: T0, updatedAt: T0,
    });
    expect(getScan(scan.id)).toEqual(scan);
  });

  it("inserts an every-N scan ready for review, proposing its layout", () => {
    const scan = insertScan(newScan({ status: "review", splitMode: "every", pagesPerPaper: 2, layout: LAYOUT }));
    expect(scan).toMatchObject({ status: "review", splitMode: "every", pagesPerPaper: 2, layout: LAYOUT, proposedLayout: LAYOUT, splitStartedAt: null });
  });

  it("getScanForTeacher scopes by the owning teacher", () => {
    const scan = insertScan(newScan());
    expect(getScanForTeacher(scan.id, teacher.id)).toEqual({ scan, assignment });
    expect(getScanForTeacher(scan.id, seedTeacher().id)).toBeNull();
    expect(getScanForTeacher("missing", teacher.id)).toBeNull();
    expect(getScan("missing")).toBeNull();
  });

  it("lists an assignment's scans newest first and finds one by content", () => {
    const older = insertScan(newScan({ contentSha256: "same" }));
    setClockForTests(() => T0 + 1);
    const newer = insertScan(newScan());
    const elsewhere = seedAssignment(teacher.id);
    insertScan(newScan({ assignmentId: elsewhere.id, contentSha256: "same" }));

    expect(listScans(assignment.id).map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(findScanBySha(assignment.id, "same")?.id).toBe(older.id);
    expect(findScanBySha(assignment.id, "other")).toBeNull();
  });
});

describe("updateScan", () => {
  it("round-trips readings, layouts, usage and counts, and bumps updated_at", () => {
    const scan = insertScan(newScan());
    setClockForTests(() => T0 + 9);
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };

    const updated = updateScan(scan.id, {
      status: "done", readings: [READING, null, { ...READING, reported: false }], pagesRead: 2, layout: LAYOUT,
      proposedLayout: LAYOUT, statusNote: "note", errorMessage: "error", aiModel: "claude-opus-5-5", usage, createdCount: 1,
      duplicateCount: 0, splitMode: "every", pagesPerPaper: 3, splitGeneration: 4, splitStartedAt: T0 + 1, splitFinishedAt: T0 + 5,
      autoGraded: true,
    });

    expect(updated).toEqual({
      ...scan, status: "done", readings: [READING, null, { ...READING, reported: false }], pagesRead: 2, layout: LAYOUT,
      proposedLayout: LAYOUT, statusNote: "note", errorMessage: "error", aiModel: "claude-opus-5-5", usage, createdCount: 1,
      duplicateCount: 0, splitMode: "every", pagesPerPaper: 3, splitGeneration: 4, splitStartedAt: T0 + 1, splitFinishedAt: T0 + 5,
      autoGraded: true, updatedAt: T0 + 9,
    });
    expect(getScan(scan.id)).toEqual(updated);
    expect(updateScan(scan.id, { layout: null, usage: null })).toMatchObject({ layout: null, usage: null, proposedLayout: LAYOUT });
  });

  it("throws not_found for a missing scan", () => {
    expect(() => updateScan("missing", { status: "review" })).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("updateSplittingScan", () => {
  it("writes only while the scan is splitting on the given generation", () => {
    const scan = insertScan(newScan());

    expect(updateSplittingScan(scan.id, 2, { pagesRead: 1 })).toBe(false);
    expect(getScan(scan.id)!.pagesRead).toBe(0);

    expect(updateSplittingScan(scan.id, 1, { pagesRead: 3, readings: [READING, READING, READING] })).toBe(true);
    expect(getScan(scan.id)).toMatchObject({ pagesRead: 3, readings: [READING, READING, READING] });

    updateScan(scan.id, { status: "review", splitGeneration: 2 });
    expect(updateSplittingScan(scan.id, 2, { status: "failed" })).toBe(false);
    expect(getScan(scan.id)!.status).toBe("review");
    expect(updateSplittingScan("missing", 1, { pagesRead: 1 })).toBe(false);
  });
});

describe("deletion and boot recovery", () => {
  it("deletes a scan row, and an assignment's scans with it", async () => {
    const kept = await seedScan(assignment.id, { writeFile: false });
    const deleted = await seedScan(assignment.id, { writeFile: false });

    deleteScanRow(deleted.id);
    expect(listScans(assignment.id).map((s) => s.id)).toEqual([kept.id]);

    deleteAssignmentRow(assignment.id);
    expect(getScan(kept.id)).toBeNull();
  });

  it("lists splitting scans that have no queued or running split job", async () => {
    const orphan = await seedScan(assignment.id, { writeFile: false });
    setClockForTests(() => T0 + 1);
    const finishedJob = await seedScan(assignment.id, { writeFile: false });
    const queued = await seedScan(assignment.id, { writeFile: false });
    const running = await seedScan(assignment.id, { writeFile: false });
    await seedScan(assignment.id, { status: "review", writeFile: false });
    const split = (scanId: string) =>
      enqueueJob({ kind: "split_scan", targetId: scanId, assignmentId: assignment.id, priority: 5, maxAttempts: 4 });
    split(finishedJob.id);
    completeJob(claimNextJob(T0 + 1)!.id);
    split(running.id);
    claimNextJob(T0 + 1);
    split(queued.id);

    expect(listSplittingScansWithoutJob()).toEqual([
      { id: orphan.id, assignmentId: assignment.id }, { id: finishedJob.id, assignmentId: assignment.id },
    ]);
  });

  it("puts scans left creating back to review", async () => {
    const creating = await seedScan(assignment.id, { status: "creating", layout: LAYOUT, writeFile: false });
    const done = await seedScan(assignment.id, { status: "done", layout: LAYOUT, writeFile: false });

    expect(resetCreatingScans()).toBe(1);

    expect(getScan(creating.id)!.status).toBe("review");
    expect(getScan(done.id)!.status).toBe("done");
    expect(resetCreatingScans()).toBe(0);
  });
});

describe("recentSplitPageDurations", () => {
  it("lists ms per page of recent finished splits, newest first, of one assignment or of all", () => {
    const other = seedAssignment(teacher.id);
    const a = insertScan(newScan());
    updateScan(a.id, { splitStartedAt: T0, splitFinishedAt: T0 + 30_000 }); // 3 pages
    const b = insertScan(newScan({ assignmentId: other.id, pdfPath: scanPdfRel(other.id, newId()) }));
    updateScan(b.id, { splitStartedAt: T0, splitFinishedAt: T0 + 60_000 + 3_000 });
    insertScan(newScan()); // still splitting

    expect(recentSplitPageDurations(assignment.id, 20)).toEqual([10_000]);
    expect(recentSplitPageDurations(null, 20)).toEqual([21_000, 10_000]);
    expect(recentSplitPageDurations(null, 1)).toEqual([21_000]);
  });
});
