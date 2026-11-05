import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { createFakeGrader } from "@/lib/ai/fake";
import type { Grader, ReadScanInput } from "@/lib/ai/grader";
import { setGraderForTests } from "@/lib/ai/index";
import { setClockForTests } from "@/lib/clock";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { getDb } from "@/lib/db/connection";
import { getAssignmentUsage } from "@/lib/db/repos/assignments";
import { getScan } from "@/lib/db/repos/scans";
import { listSubmissions } from "@/lib/db/repos/submissions";
import { SCAN_CHUNK_MAX_PAGES } from "@/lib/grading/split";
import { enqueueSplitScan, PRIORITY } from "@/lib/jobs/queue";
import { deferred, drainQueue, FAKE_META, jobRows, scriptedGrader } from "@/lib/jobs/test-utils";
import { createWorker, startWorker } from "@/lib/jobs/worker";
import { papersFromLayout } from "@/lib/scan-layout";
import { deleteScan, splitScanEvery } from "@/lib/services/scans";
import * as files from "@/lib/storage/files";
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

/** A retryable error that uses up an attempt (a rate limit or overload does not). */
function temporaryError(): AiError {
  return new AiError("server_error", "temporary trouble", { retryable: true });
}

/** SCAN_SPLIT_PARALLEL for this test. */
function readInParallel(n: number): void {
  vi.stubEnv("SCAN_SPLIT_PARALLEL", String(n));
  resetConfigForTests();
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
  it("proposes one paper per worksheet length and, with nothing to check, grades them at once", async () => {
    const scan = await queuedScan(9);

    // The split, then the three papers it created.
    expect(await drainQueue()).toBe(4);

    const split = getScan(scan.id)!;
    expect(split).toMatchObject({
      status: "done", autoGraded: true, createdCount: 3, duplicateCount: 0, pagesRead: 9, statusNote: null, errorMessage: null,
      aiModel: "fake", splitStartedAt: T0, splitFinishedAt: T0,
    });
    expect(split.readings).toHaveLength(9);
    expect(split.readings.every((reading) => reading?.reported === true)).toBe(true);
    expect(papersFromLayout(split.layout!)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(split.proposedLayout).toEqual(split.layout);
    expect(split.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(jobRows(scan.id)).toMatchObject([{ kind: "split_scan", status: "done", priority: PRIORITY.splitScan, attempts: 1 }]);
    const papers = listSubmissions(assignment.id);
    expect(papers.map((p) => [p.source, p.pageCount, p.originalFilename])).toEqual([
      ["teacher", 3, "scan.pdf (pages 1–3)"], ["teacher", 3, "scan.pdf (pages 4–6)"], ["teacher", 3, "scan.pdf (pages 7–9)"],
    ]);
    expect(papers.every((p) => p.status === "graded" || p.status === "needs_review")).toBe(true);
  });

  it("leaves a split with anything to check in review for the teacher", async () => {
    // Ten pages of three-page papers: the last paper has one page (page_count).
    const scan = await queuedScan(10);

    expect(await drainQueue()).toBe(1);

    expect(getScan(scan.id)).toMatchObject({ status: "review", autoGraded: false, createdCount: null, pagesRead: 10, splitFinishedAt: T0 });
    expect(listSubmissions(assignment.id)).toEqual([]);
  });

  it("leaves a clean split in review when a paper is read with low confidence, or has no name", async () => {
    const lowConfidence = await queuedScan(6);
    await drainQueue(scriptedGrader({
      async readScanPages(input, options) {
        const result = await instantFake.readScanPages(input, options);
        return { ...result, output: { pages: result.output.pages.map((p, i) => (i === 4 ? { ...p, confidence: "low" as const } : p)) } };
      },
    }));
    expect(getScan(lowConfidence.id)).toMatchObject({ status: "review", autoGraded: false });

    const noName = await queuedScan(3);
    await drainQueue(scriptedGrader({
      async readScanPages(input, options) {
        const result = await instantFake.readScanPages(input, options);
        return { ...result, output: { pages: result.output.pages.map((p) => ({ ...p, student_name: null })) } };
      },
    }));
    expect(getScan(noName.id)).toMatchObject({ status: "review", autoGraded: false });
    expect(listSubmissions(assignment.id)).toEqual([]);
  });

  it("leaves a clean split in review when its papers would pass the submission limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getDb().prepare("UPDATE assignments SET max_submissions = 2 WHERE id = ?").run(assignment.id);
    const scan = await queuedScan(9);

    expect(await drainQueue()).toBe(1);

    expect(getScan(scan.id)).toMatchObject({ status: "review", autoGraded: false, createdCount: null });
    expect(listSubmissions(assignment.id)).toEqual([]);
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

  it("tells the AI how the page before each later chunk was read, when chunks are read one at a time", async () => {
    readInParallel(1);
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
    const grader = recordingReader(calls, (call) => (call === 2 ? temporaryError() : null));

    expect(await runOnce(grader)).toBe(true);
    const [job] = jobRows(scan.id);
    expect(job).toMatchObject({ status: "queued", attempts: 0, last_error: "server_error: temporary trouble" });
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

    await runOnce(recordingReader([], (call) => (call === 2 ? temporaryError() : null)));

    const maxAttempts = getConfig().jobMaxAttempts;
    expect(jobRows(scan.id)).toMatchObject([{ status: "queued", attempts: maxAttempts - 1 }]);
    expect(getScan(scan.id)).toMatchObject({ status: "splitting", pagesRead: 20 });
  });

  it("fails a run on its last attempt that made no progress, pointing to every N pages", async () => {
    const scan = await queuedScan(9);
    getDb().prepare("UPDATE jobs SET attempts = max_attempts - 1 WHERE target_id = ?").run(scan.id);

    await runOnce(recordingReader([], () => temporaryError()));

    expect(jobRows(scan.id)).toMatchObject([{ status: "failed", last_error: "server_error: temporary trouble" }]);
    expect(getScan(scan.id)).toMatchObject({
      status: "failed", statusNote: null,
      errorMessage: "The AI service failed (server_error). Try again or split the scan every N pages.",
    });
  });

  it("waits out an overload on its last attempt without progress, instead of failing the scan", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scan = await queuedScan(9);
    getDb().prepare("UPDATE jobs SET attempts = max_attempts - 1 WHERE target_id = ?").run(scan.id);

    await runOnce(recordingReader([], () => overloaded()));

    const [job] = jobRows(scan.id);
    expect(job).toMatchObject({ status: "queued", attempts: getConfig().jobMaxAttempts - 1, last_error: "overloaded: temporary trouble" });
    expect(job.run_after).toBeGreaterThan(clock);
    expect(getScan(scan.id)).toMatchObject({ status: "splitting", pagesRead: 0, statusNote: "Waiting: the AI service asked us to slow down" });
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

describe("reading chunks in parallel", () => {
  /** A reader whose calls wait until the test settles them by first page: `settle(firstPage, err?)`. */
  function gatedReader() {
    const pending = new Map<number, { resolve: () => void; reject: (err: AiError) => void }>();
    const calls: ReadScanInput[] = [];
    let active = 0;
    let maxActive = 0;
    const grader = scriptedGrader({
      readScanPages: (input, options) => {
        calls.push(input);
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve, reject) => {
          pending.set(input.firstPage, {
            resolve: () => {
              active--;
              resolve(instantFake.readScanPages(input, options));
            },
            reject: (err) => {
              active--;
              reject(err);
            },
          });
        });
      },
    });
    const settle = async (firstPage: number, err?: AiError) => {
      await vi.waitFor(() => expect(pending.has(firstPage)).toBe(true));
      const call = pending.get(firstPage)!;
      pending.delete(firstPage);
      if (err) call.reject(err);
      else call.resolve();
    };
    return { grader, calls, settle, maxActive: () => maxActive };
  }

  const unread = (scan: Scan) => getScan(scan.id)!.readings.flatMap((r, i) => (r === null ? [i + 1] : []));

  it("reads up to SCAN_SPLIT_PARALLEL chunks at once and saves each as it finishes, in any order", async () => {
    readInParallel(2);
    const scan = await queuedScan(65); // chunks 1–20, 21–40, 41–60, 61–65
    const { grader, calls, settle, maxActive } = gatedReader();
    const run = runOnce(grader);

    await vi.waitFor(() => expect(calls.map((c) => c.firstPage)).toEqual([1, 21]));
    // The second chunk finishes first: its pages are saved at once.
    await settle(21);
    await vi.waitFor(() => expect(getScan(scan.id)!.pagesRead).toBe(20));
    expect(unread(scan)).toEqual([...range(1, 20), ...range(41, 65)]);
    await vi.waitFor(() => expect(calls.map((c) => c.firstPage)).toEqual([1, 21, 41]));
    expect(getScan(scan.id)!.status).toBe("splitting");

    await settle(41);
    await settle(1);
    await settle(61);
    expect(await run).toBe(true);

    expect(maxActive()).toBe(2);
    expect(calls.map((c) => [c.firstPage, c.chunkPageCount])).toEqual([[1, 20], [21, 20], [41, 20], [61, 5]]);
    // Grouped only once every page was read.
    expect(getScan(scan.id)).toMatchObject({ pagesRead: 65, splitFinishedAt: T0 });
    expect(["review", "done"]).toContain(getScan(scan.id)!.status);
  });

  it("re-reads only the chunks still unread after a failure, keeping the ones read out of order", async () => {
    readInParallel(2);
    const scan = await queuedScan(65);
    const first = gatedReader();
    const run = runOnce(first.grader);

    await first.settle(1, temporaryError());
    await first.settle(21);
    expect(await run).toBe(true);

    // No new chunk started after the failure; the chunk being read finished and was saved.
    expect(first.calls.map((c) => c.firstPage)).toEqual([1, 21]);
    const [job] = jobRows(scan.id);
    expect(job).toMatchObject({ status: "queued", attempts: 0 }); // progress: the attempt is refunded
    expect(getScan(scan.id)).toMatchObject({ status: "splitting", pagesRead: 20 });
    expect(unread(scan)).toEqual([...range(1, 20), ...range(41, 65)]);

    clock = job.run_after;
    const calls: ReadScanInput[] = [];
    await runOnce(recordingReader(calls));

    expect(calls.map((c) => [c.firstPage, c.chunkPageCount])).toEqual([[1, 20], [41, 20], [61, 5]]);
    expect(getScan(scan.id)!.pagesRead).toBe(65);
    expect(["review", "done"]).toContain(getScan(scan.id)!.status);
  });

  it("reads the scan file once per chunk, one chunk at a time, so only the chunks being read stay in memory", async () => {
    readInParallel(4);
    const scan = await queuedScan(65);
    const original = files.readDataFile;
    let reading = 0;
    let maxReading = 0;
    const read = vi.spyOn(files, "readDataFile").mockImplementation(async (rel) => {
      reading++;
      maxReading = Math.max(maxReading, reading);
      try {
        return await original(rel);
      } finally {
        reading--;
      }
    });
    const { grader, calls, settle, maxActive } = gatedReader();
    const run = runOnce(grader);

    await vi.waitFor(() => expect(calls).toHaveLength(4));
    for (const page of [61, 41, 21, 1]) await settle(page);
    await run;

    expect(maxActive()).toBe(4);
    expect(read.mock.calls.filter(([rel]) => rel === scan.pdfPath)).toHaveLength(4);
    expect(maxReading).toBe(1);
    expect(getScan(scan.id)!.pagesRead).toBe(65);
  });

  it("writes nothing when the teacher splits every N pages while chunks are being read", async () => {
    readInParallel(2);
    const scan = await queuedScan(25);
    const { grader, calls, settle } = gatedReader();
    const run = runOnce(grader);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    splitScanEvery(getScan(scan.id)!, 5);
    await settle(21);
    await settle(1);
    await run;

    expect(getScan(scan.id)).toMatchObject({ status: "review", splitMode: "every", splitGeneration: 2, pagesRead: 0, readings: [] });
    expect(jobRows(scan.id)).toMatchObject([{ status: "done" }]);
  });
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe("splitting with the hosted agent", () => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

  function capped(agent: { listCostCents: number | null; activeSeconds: number } | null = null): AiError {
    return new AiError("budget_reached", "The hosted agent reached its spending cap for this task.", {
      retryable: true, billed: agent ? { servedModel: "claude-opus-5-5", usage, agent } : null,
    });
  }

  it("adds every session to the usage, and reads a chunk that reached the spending cap again with double the cap", async () => {
    const scan = await queuedScan(25);
    const budgets: Array<number | undefined> = [];
    const grader = scriptedGrader({
      engine: "agent",
      async readScanPages(input, options) {
        budgets.push(options?.maxTokens);
        if (budgets.length === 2) throw capped({ listCostCents: 150, activeSeconds: 90 });
        const { output } = await instantFake.readScanPages(input, options);
        return { output, meta: { ...FAKE_META, servedModel: "claude-opus-5-5", usage, agent: { listCostCents: 40, activeSeconds: 30 } } };
      },
    });

    await runOnce(grader);
    expect(jobRows(scan.id)).toMatchObject([{ status: "queued", max_tokens: 128_000, run_after: clock }]);
    expect(getScan(scan.id)).toMatchObject({
      status: "splitting", pagesRead: 20, statusNote: "Retrying with a larger spending cap for the hosted agent",
    });

    await runOnce(grader);
    expect(budgets).toEqual([64_000, 64_000, 128_000]);
    expect(getScan(scan.id)).toMatchObject({ status: "review", pagesRead: 25 });
    expect(getAssignmentUsage(assignment.id)).toEqual({
      "claude-opus-5-5": {
        calls: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0,
        agent: {
          sessions: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, listCostCents: 230, unpricedSessions: 0,
          activeSeconds: 150,
        },
      },
    });
  });

  it("fails a scan that reached the spending cap even at double the cap, pointing to every N pages", async () => {
    const scan = await queuedScan(9);

    await drainQueue(recordingReader([], () => capped()));

    expect(getScan(scan.id)).toMatchObject({
      status: "failed",
      errorMessage: "The hosted agent reached its spending cap. Split the scan every N pages instead, or raise AGENT_BUDGET_SCAN_USD on the server.",
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
