import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { updateKey } from "@/lib/db/repos/keys";
import { getScan, updateScan } from "@/lib/db/repos/scans";
import { countSubmissions, listSubmissions } from "@/lib/db/repos/submissions";
import { sha256Hex } from "@/lib/ids";
import { PRIORITY } from "@/lib/jobs/queue";
import { jobRows } from "@/lib/jobs/test-utils";
import { everyNLayout } from "@/lib/scan-layout";
import { createPapersFromScan, deleteScan, ingestScan, retryScanWithAi, splitScanEvery } from "@/lib/services/scans";
import { scanPdfRel } from "@/lib/storage/paths";
import type { UploadedFile } from "@/lib/storage/pdf";
import type { Assignment, Scan, ScanLayout } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  seedApprovedKey(assignment.id, [{ label: "1" }]);
});

async function scanFile(pages: number, label = "stack"): Promise<UploadedFile> {
  return { filename: `${label}.pdf`, bytes: await makePdf(pages, { label }) };
}

function stored(scan: Pick<Scan, "pdfPath">): boolean {
  return fs.existsSync(path.join(getConfig().dataDir, scan.pdfPath));
}

/** A scan uploaded to be split every `n` pages, ready for review. */
async function reviewScan(pages: number, n: number, label = "stack"): Promise<Scan> {
  return ingestScan(assignment, await scanFile(pages, label), { mode: "every", pagesPerPaper: n });
}

describe("ingestScan", () => {
  it("stores an automatic scan and queues its split", async () => {
    const scan = await ingestScan(assignment, await scanFile(9), { mode: "auto", pagesPerPaper: 4 });

    expect(scan).toMatchObject({
      assignmentId: assignment.id, status: "splitting", splitMode: "auto", pagesPerPaper: null, splitGeneration: 1,
      pdfPath: scanPdfRel(assignment.id, scan.id), originalFilename: "stack.pdf", pageCount: 9, layout: null, readings: [],
    });
    expect(stored(scan)).toBe(true);
    expect(jobRows(scan.id)).toMatchObject([{ kind: "split_scan", status: "queued", priority: PRIORITY.splitScan }]);
  });

  it("splits every N pages at once, without the AI", async () => {
    const scan = await reviewScan(7, 3);

    expect(scan).toMatchObject({ status: "review", splitMode: "every", pagesPerPaper: 3, layout: everyNLayout(7, 3) });
    expect(scan.proposedLayout).toEqual(scan.layout);
    expect(jobRows(scan.id)).toEqual([]);
  });

  it.each([null, 0, 101, 2.5])("refuses %s pages per student", async (n) => {
    await expect(ingestScan(assignment, await scanFile(4), { mode: "every", pagesPerPaper: n })).rejects.toMatchObject({
      code: "validation", extra: { fieldErrors: { pagesPerPaper: ["Pages per student must be a whole number from 1 to 100."] } },
    });
  });

  it("needs an approved key", async () => {
    const draft = seedAssignment(seedTeacher().id);
    await expect(ingestScan(draft, await scanFile(3), { mode: "auto", pagesPerPaper: null })).rejects.toMatchObject({ code: "key_not_ready" });
  });

  it("refuses the answer key and a scan with more than MAX_SCAN_PAGES pages", async () => {
    const key = await scanFile(2, "key");
    updateKey(assignment.id, { sourceSha256: sha256Hex(key.bytes) });
    await expect(ingestScan(assignment, key, { mode: "auto", pagesPerPaper: null })).rejects.toMatchObject({ code: "is_answer_key" });

    vi.stubEnv("MAX_SCAN_PAGES", "5");
    resetConfigForTests();
    await expect(ingestScan(assignment, await scanFile(6), { mode: "auto", pagesPerPaper: null })).rejects.toMatchObject({
      code: "too_many_pages",
    });
  });

  it("refuses the same scan twice, unless the earlier one failed", async () => {
    const file = await scanFile(4);
    const first = await ingestScan(assignment, file, { mode: "auto", pagesPerPaper: null });
    await expect(ingestScan(assignment, file, { mode: "every", pagesPerPaper: 2 })).rejects.toMatchObject({
      code: "duplicate", message: "You already uploaded this scan.",
    });

    updateScan(first.id, { status: "failed", errorMessage: "The AI declined to read this scan. Split it every N pages instead." });
    const second = await ingestScan(assignment, file, { mode: "every", pagesPerPaper: 2 });

    expect(getScan(first.id)).toBeNull();
    expect(stored(first)).toBe(false);
    expect(jobRows(first.id)).toMatchObject([{ status: "cancelled" }]);
    expect(getScan(second.id)).toMatchObject({ status: "review" });
  });
});

describe("changing the split", () => {
  it("splitScanEvery replaces an AI split, keeping the readings and cancelling the queued job", async () => {
    const scan = await ingestScan(assignment, await scanFile(6), { mode: "auto", pagesPerPaper: null });

    const every = splitScanEvery(scan, 2);

    expect(every).toMatchObject({
      status: "review", splitMode: "every", pagesPerPaper: 2, splitGeneration: 2, layout: everyNLayout(6, 2), errorMessage: null,
    });
    expect(every.proposedLayout).toEqual(every.layout);
    expect(jobRows(scan.id)).toMatchObject([{ status: "cancelled" }]);
    expect(() => splitScanEvery(every, 0)).toThrow(expect.objectContaining({ code: "validation" }));
  });

  it("retryScanWithAi starts the AI split over", async () => {
    const scan = await reviewScan(6, 2);

    const retried = retryScanWithAi(scan);

    expect(retried).toMatchObject({
      status: "splitting", splitMode: "auto", pagesPerPaper: null, splitGeneration: 2, readings: [], pagesRead: 0, layout: null,
      proposedLayout: null,
    });
    expect(jobRows(scan.id)).toMatchObject([{ kind: "split_scan", status: "queued" }]);
    expect(() => retryScanWithAi(retried)).toThrow(expect.objectContaining({
      code: "invalid_state", message: "The AI is still splitting this scan.",
    }));
  });

  it("refuses both once papers are being or were created", async () => {
    const scan = await reviewScan(4, 2);
    for (const [status, message] of [
      ["creating", "These papers are already being created."], ["done", "Papers were already created from this scan."],
    ] as const) {
      updateScan(scan.id, { status });
      expect(() => splitScanEvery(scan, 2)).toThrow(expect.objectContaining({ code: "invalid_state", message }));
      expect(() => retryScanWithAi(scan)).toThrow(expect.objectContaining({ code: "invalid_state", message }));
    }
  });
});

describe("createPapersFromScan", () => {
  it("creates one teacher paper per group of kept pages and queues its grading", async () => {
    const scan = await reviewScan(9, 3);
    const layout: ScanLayout = scan.layout!.map((page, i) => (i === 4 ? { startsPaper: false, dropped: true } : page));

    expect(await createPapersFromScan(assignment, scan, layout)).toEqual({ created: 3, duplicates: 0 });

    const papers = listSubmissions(assignment.id).sort((a, b) => a.originalFilename.localeCompare(b.originalFilename));
    expect(papers.map((p) => [p.originalFilename, p.pageCount, p.source, p.status])).toEqual([
      ["stack.pdf (pages 1–3)", 3, "teacher", "queued"],
      ["stack.pdf (pages 4, 6)", 2, "teacher", "queued"],
      ["stack.pdf (pages 7–9)", 3, "teacher", "queued"],
    ]);
    for (const p of papers) expect(jobRows(p.id)).toMatchObject([{ kind: "grade_submission", priority: PRIORITY.teacher }]);
    expect(getScan(scan.id)).toMatchObject({ status: "done", createdCount: 3, duplicateCount: 0, layout });
  });

  it("creates nothing twice when run again after a crash", async () => {
    const scan = await reviewScan(6, 2);
    await createPapersFromScan(assignment, scan, scan.layout!);
    updateScan(scan.id, { status: "review" }); // what boot recovery does with a scan left "creating"

    expect(await createPapersFromScan(assignment, scan, everyNLayout(6, 3))).toEqual({ created: 2, duplicates: 0 });
    expect(await createPapersFromScan(assignment, scan, scan.layout!).catch((e) => e.code)).toBe("invalid_state");
    updateScan(scan.id, { status: "review" });
    expect(await createPapersFromScan(assignment, scan, scan.layout!)).toEqual({ created: 0, duplicates: 3 });
    expect(countSubmissions(assignment.id)).toBe(5);
  });

  it("checks the layout before anything else", async () => {
    const scan = await reviewScan(4, 2);
    await expect(createPapersFromScan(assignment, scan, everyNLayout(3, 1))).rejects.toMatchObject({ code: "validation" });
    const allDropped = scan.layout!.map(() => ({ startsPaper: false, dropped: true }));
    await expect(createPapersFromScan(assignment, scan, allDropped)).rejects.toMatchObject({
      code: "validation", message: "Keep at least one page.",
    });
    vi.stubEnv("MAX_PAGES", "3");
    resetConfigForTests();
    await expect(createPapersFromScan(assignment, scan, everyNLayout(4, 4))).rejects.toMatchObject({
      code: "validation", message: "Paper 1 has 4 pages; the limit is 3. Mark where the next paper starts.",
    });
    expect(getScan(scan.id)!.status).toBe("review");
    expect(countSubmissions(assignment.id)).toBe(0);
  });

  it("refuses more papers than the assignment can take, before storing any", async () => {
    const limited = seedAssignment(seedTeacher().id, { maxSubmissions: 2 });
    seedApprovedKey(limited.id, [{ label: "1" }]);
    const scan = await ingestScan(limited, await scanFile(3), { mode: "every", pagesPerPaper: 1 });

    await expect(createPapersFromScan(limited, scan, scan.layout!)).rejects.toMatchObject({
      code: "submission_limit", message: "This assignment can take only 2 more papers. Raise the limit in the assignment's Settings.",
    });
    expect(countSubmissions(limited.id)).toBe(0);
    expect(getScan(scan.id)!.status).toBe("review");
  });

  it("refuses a paper larger than MAX_UPLOAD_MB and puts the scan back to review", async () => {
    vi.stubEnv("MAX_UPLOAD_MB", "1");
    resetConfigForTests();
    const scan = await ingestScan(assignment, { filename: "heavy.pdf", bytes: await pdfWithHeavyPage(4, 3) }, { mode: "every", pagesPerPaper: 2 });

    await expect(createPapersFromScan(assignment, scan, scan.layout!)).rejects.toMatchObject({
      code: "too_large",
      message: expect.stringMatching(/^Paper 2 \(pages 3–4\) is 1\.\d MB; papers can be at most 1 MB\. Rescan at a lower resolution\.$/),
    });
    expect(getScan(scan.id)!.status).toBe("review");
    expect(countSubmissions(assignment.id)).toBe(0);
  });

  it("puts the scan back to review when its file is gone", async () => {
    const scan = await reviewScan(4, 2);
    fs.rmSync(path.join(getConfig().dataDir, scan.pdfPath));

    await expect(createPapersFromScan(assignment, scan, scan.layout!)).rejects.toMatchObject({ code: "file_missing" });
    expect(getScan(scan.id)!.status).toBe("review");
  });

  it("needs a scan in review and an approved key", async () => {
    const scan = await reviewScan(4, 2);
    updateKey(assignment.id, { approvedRevision: null });
    await expect(createPapersFromScan(assignment, scan, scan.layout!)).rejects.toMatchObject({ code: "key_not_ready" });
    expect(getScan(scan.id)!.status).toBe("review");

    updateScan(scan.id, { status: "splitting" });
    await expect(createPapersFromScan(assignment, scan, scan.layout!)).rejects.toMatchObject({
      code: "invalid_state", message: "These papers are already being created.",
    });
  });
});

describe("deleteScan", () => {
  it("removes the scan and its file, and keeps the papers created from it", async () => {
    const scan = await reviewScan(4, 2);
    await createPapersFromScan(assignment, scan, scan.layout!);

    await deleteScan(getScan(scan.id)!);

    expect(getScan(scan.id)).toBeNull();
    expect(stored(scan)).toBe(false);
    expect(countSubmissions(assignment.id)).toBe(2);
  });

  it("is refused while papers are being created", async () => {
    const scan = await reviewScan(4, 2);
    updateScan(scan.id, { status: "creating" });

    await expect(deleteScan(scan)).rejects.toMatchObject({ code: "invalid_state", message: "These papers are already being created." });
    expect(stored(scan)).toBe(true);
  });
});

/** `pages` pages; page `heavy` carries an incompressible 1.2 MiB stream that copying a page brings along. */
async function pdfWithHeavyPage(pages: number, heavy: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792]);
    if (i === heavy) page.node.set(PDFName.of("PieceInfo"), doc.context.register(doc.context.stream(randomBytes(1_250_000))));
  }
  return doc.save();
}
