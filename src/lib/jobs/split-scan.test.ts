import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { createFakeGrader } from "@/lib/ai/fake";
import type { Grader, ReadScanInput } from "@/lib/ai/grader";
import { setGraderForTests } from "@/lib/ai/index";
import { setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/connection";
import { getScan } from "@/lib/db/repos/scans";
import { SCAN_CHUNK_MAX_PAGES } from "@/lib/grading/split";
import { enqueueSplitScan, PRIORITY } from "@/lib/jobs/queue";
import { deferred, drainQueue, jobRows, scriptedGrader } from "@/lib/jobs/test-utils";
import { createWorker, startWorker } from "@/lib/jobs/worker";
import { papersFromLayout } from "@/lib/scan-layout";
import { deleteScan, splitScanEvery } from "@/lib/services/scans";
import { validatePdf } from "@/lib/storage/pdf";
import type { Assignment, Scan } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedScan, seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
let clock = T0;
let assignment: Assignment;

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  // A three-page worksheet: the fake reader groups pages in threes.
  seedApprovedKey(assignment.id, [{ label: "1", page: 1 }, { label: "2", page: 2 }, { label: "3", page: 3 }]);
});

const instantFake = createFakeGrader({ delayMs: 0 });

async function queuedScan(pages: number): Promise<Scan> {
  const scan = await seedScan(assignment.id, { pages });
  enqueueSplitScan(scan.id, assignment.id);
  return scan;
}

/** The instant fake reader, recording every chunk it was sent; `fail(callIndex)` may return an error to throw instead. */
function recordingReader(calls: ReadScanInput[], fail: (call: number) => AiError | null = () => null): Grader {
  return scriptedGrader({
    async readScanPages(input, options) {
      calls.push(input);
      const err = fail(calls.length);
      if (err) throw err;
      return instantFake.readScanPages(input, options);
    },
  });
}

function overloaded(): AiError {
  return new AiError("overloaded", "temporary trouble", { retryable: true });
}

function runOnce(grader: Grader): Promise<boolean> {
  return createWorker({ grader, concurrency: 1, pollMs: 1000 }).runOnce();
}

/** Starts a run whose AI call waits for the returned `release`; resolves once the call is in flight. */
async function startBlockedSplit(): Promise<{ finish: () => Promise<boolean> }> {
  const gate = deferred<void>();
  const called = deferred<void>();
  const run = runOnce(scriptedGrader({
    async readScanPages(input, options) {
      called.resolve();
      await gate.promise;
      return instantFake.readScanPages(input, options);
    },
  }));
  await called.promise;
  return { finish: async () => (gate.resolve(), run) };
}

describe("splitting a scan with the fake reader", () => {
  it("proposes one paper per worksheet length and waits for the teacher's check", async () => {
    const scan = await queuedScan(9);

    expect(await drainQueue()).toBe(1);

    const split = getScan(scan.id)!;
    expect(split).toMatchObject({ status: "review", pagesRead: 9, statusNote: null, errorMessage: null, aiModel: "fake" });
    expect(split.readings).toHaveLength(9);
    expect(split.readings.every((reading) => reading?.reported === true)).toBe(true);
    expect(papersFromLayout(split.layout!)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(split.proposedLayout).toEqual(split.layout);
    expect(split.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(jobRows(scan.id)).toMatchObject([{ kind: "split_scan", status: "done", priority: PRIORITY.splitScan, attempts: 1 }]);
  });

  it("runs before the answer key is approved", async () => {
    assignment = seedAssignment(seedTeacher().id);
    const scan = await queuedScan(4);

    expect(await drainQueue()).toBe(1);
    expect(getScan(scan.id)!.status).toBe("review");
  });

  it("sends the scan in chunks of at most SCAN_CHUNK_MAX_PAGES pages, with the worksheet outline", async () => {
    const scan = await queuedScan(25);
    const calls: ReadScanInput[] = [];

    await drainQueue(recordingReader(calls));

    expect(calls.map((c) => [c.firstPage, c.chunkPageCount, c.totalPages])).toEqual([[1, SCAN_CHUNK_MAX_PAGES, 25], [21, 5, 25]]);
    expect((await validatePdf(calls[0].chunkPdf, { maxPages: 500 })).pageCount).toBe(SCAN_CHUNK_MAX_PAGES);
    expect((await validatePdf(calls[1].chunkPdf, { maxPages: 500 })).pageCount).toBe(5);
    expect(calls[0]).toMatchObject({ assignmentTitle: assignment.title, keyPageCount: 3 });
    expect(calls[0].items.map((item) => item.label)).toEqual(["1", "2", "3"]);
    expect(getScan(scan.id)).toMatchObject({ status: "review", pagesRead: 25 });
  });

  it("tells the AI how the page before each later chunk was read", async () => {
    await queuedScan(25);
    const calls: ReadScanInput[] = [];

    await drainQueue(recordingReader(calls));

    expect(calls[0].previousPage).toBeNull();
    // Page 20 of three-page papers is page 2 of the seventh paper.
    expect(calls[1].previousPage).toEqual({ page: 20, kind: "student_work", studentName: null, worksheetPage: 2, pageMarker: "2 of 3" });
  });

  it("describes no page before a chunk when the AI skipped that page", async () => {
    await queuedScan(25);
    const calls: ReadScanInput[] = [];
    const skipsLastPage = scriptedGrader({
      async readScanPages(input, options) {
        calls.push(input);
        const result = await instantFake.readScanPages(input, options);
        return calls.length === 1 ? { ...result, output: { pages: result.output.pages.slice(0, -1) } } : result;
      },
    });

    await drainQueue(skipsLastPage);

    expect(calls.map((c) => c.firstPage)).toEqual([1, 21]);
    expect(calls[1].previousPage).toBeNull();
  });

  it("fails the scan when its file is missing", async () => {
    const scan = await seedScan(assignment.id, { pages: 3, writeFile: false });
    enqueueSplitScan(scan.id, assignment.id);

    await drainQueue();

    expect(getScan(scan.id)).toMatchObject({ status: "failed", errorMessage: "The uploaded scan is missing on the server. Upload it again." });
    expect(jobRows(scan.id)).toMatchObject([{ status: "failed" }]);
  });

  it("fails the scan when its file can't be read as a PDF", async () => {
    const scan = await queuedScan(3);
    fs.writeFileSync(path.join(getConfig().dataDir, scan.pdfPath), "not a pdf");

    await drainQueue();

    expect(getScan(scan.id)).toMatchObject({ status: "failed", errorMessage: "The scan could not be read. Upload it again." });
  });
});

describe("failures and resuming", () => {
  it("resumes after a retryable error at the first unread page, without using up the attempt", async () => {
    const scan = await queuedScan(25);
    const calls: ReadScanInput[] = [];
    const grader = recordingReader(calls, (call) => (call === 2 ? overloaded() : null));

    expect(await runOnce(grader)).toBe(true);
    const [job] = jobRows(scan.id);
    expect(job).toMatchObject({ status: "queued", attempts: 0, last_error: "overloaded: temporary trouble" });
    expect(job.run_after).toBeGreaterThan(clock);
    expect(getScan(scan.id)).toMatchObject({ status: "splitting", pagesRead: 20, statusNote: "Retrying after a temporary AI error" });
    expect(getScan(scan.id)!.readings.filter((reading) => reading === null)).toHaveLength(5);

    clock = job.run_after;
    expect(await runOnce(grader)).toBe(true);

    expect(calls.map((c) => c.firstPage)).toEqual([1, 21, 21]);
    expect(getScan(scan.id)).toMatchObject({ status: "review", pagesRead: 25, statusNote: null });
    expect(jobRows(scan.id)).toMatchObject([{ status: "done", attempts: 1 }]);
  });

  it("requeues a run on its last attempt that read a chunk before a retryable error", async () => {
    const scan = await queuedScan(25);
    getDb().prepare("UPDATE jobs SET attempts = max_attempts - 1 WHERE target_id = ?").run(scan.id);

    await runOnce(recordingReader([], (call) => (call === 2 ? overloaded() : null)));

    const maxAttempts = getConfig().jobMaxAttempts;
    expect(jobRows(scan.id)).toMatchObject([{ status: "queued", attempts: maxAttempts - 1 }]);
    expect(getScan(scan.id)).toMatchObject({ status: "splitting", pagesRead: 20 });
  });

  it("fails a run on its last attempt that made no progress, pointing to every N pages", async () => {
    const scan = await queuedScan(9);
    getDb().prepare("UPDATE jobs SET attempts = max_attempts - 1 WHERE target_id = ?").run(scan.id);

    await runOnce(recordingReader([], () => overloaded()));

    expect(jobRows(scan.id)).toMatchObject([{ status: "failed", last_error: "overloaded: temporary trouble" }]);
    expect(getScan(scan.id)).toMatchObject({
      status: "failed", statusNote: null,
      errorMessage: "The AI service failed (overloaded). Try again or split the scan every N pages.",
    });
  });

  it("retries an answer that describes too few of the pages", async () => {
    const scan = await queuedScan(4);
    await runOnce(scriptedGrader({
      async readScanPages(input, options) {
        const { output, meta } = await instantFake.readScanPages(input, options);
        return { output: { pages: output.pages.slice(0, 1) }, meta };
      },
    }));

    expect(jobRows(scan.id)).toMatchObject([{ status: "queued", attempts: 1, last_error: expect.stringMatching(/^invalid_output: /) }]);
    expect(getScan(scan.id)).toMatchObject({ status: "splitting", pagesRead: 0 });
  });

  it("fails the scan when the AI declines to read it", async () => {
    const scan = await queuedScan(9);

    await runOnce(recordingReader([], () => new AiError("refusal", "declined", { retryable: false, refusalCategory: "cyber" })));

    expect(getScan(scan.id)).toMatchObject({
      status: "failed", errorMessage: "The AI declined to read this scan. Split it every N pages instead.",
    });
    expect(jobRows(scan.id)).toMatchObject([{ status: "failed" }]);
  });

  it("pauses on a rejected key and keeps the pages already read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scan = await queuedScan(25);

    await runOnce(recordingReader([], (call) => (call === 2 ? new AiError("auth", "invalid x-api-key", { retryable: false, pauseWorker: true }) : null)));

    expect(jobRows(scan.id)).toMatchObject([{ status: "queued", attempts: 0, paused: 1, run_after: T0 + 300_000 }]);
    expect(getScan(scan.id)).toMatchObject({
      status: "splitting", pagesRead: 20, statusNote: "Paused: Anthropic rejected the API key. Replace it in Settings.",
    });
  });
});

describe("superseded runs", () => {
  it("discards the running result when the teacher splits every N pages meanwhile", async () => {
    const scan = await queuedScan(9);
    const run = await startBlockedSplit();

    splitScanEvery(getScan(scan.id)!, 3);
    await run.finish();

    const after = getScan(scan.id)!;
    expect(after).toMatchObject({ status: "review", splitMode: "every", pagesPerPaper: 3, splitGeneration: 2, pagesRead: 0, readings: [] });
    expect(papersFromLayout(after.layout!)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(jobRows(scan.id)).toMatchObject([{ status: "done" }]);
  });

  it("writes nothing for a scan deleted mid-run", async () => {
    const scan = await queuedScan(9);
    const run = await startBlockedSplit();

    await deleteScan(getScan(scan.id)!);
    await run.finish();

    expect(getScan(scan.id)).toBeNull();
    expect(fs.existsSync(path.join(getConfig().dataDir, scan.pdfPath))).toBe(false);
    expect(jobRows(scan.id)).toMatchObject([{ status: "done" }]);
  });
});

describe("boot recovery", () => {
  it("queues a split again for a splitting scan without a job, and puts a scan left creating papers back to review", async () => {
    setGraderForTests(null);
    const splitting = await seedScan(assignment.id, { pages: 3 });
    const queued = await queuedScan(3);
    const creating = await seedScan(assignment.id, { pages: 3, status: "creating", splitMode: "every", pagesPerPaper: 3 });

    vi.spyOn(console, "info").mockImplementation(() => {});
    await startWorker();

    expect(jobRows(splitting.id)).toMatchObject([{ kind: "split_scan", status: "queued", priority: PRIORITY.splitScan }]);
    expect(jobRows(queued.id)).toHaveLength(1);
    expect(getScan(creating.id)!.status).toBe("review");
  });
});
