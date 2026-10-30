import { describe, expect, it } from "vitest";
import type { BoardGroup } from "@/lib/grading/board";
import { makeKeyItem, makeSubmission } from "@/lib/grading/test-utils";
import {
  assignmentLiveSignature, buildAssignmentLiveSnapshot, buildDashboardLiveSnapshot, dashboardLiveSignature,
  LIVE_RECENT_PAPERS, type AssignmentLiveInput,
} from "@/lib/live/snapshot";
import type { AnswerKey, DashboardView, GradingProgress, KeyQuestion, Scan, StatusCounts, WorkerStatus } from "@/lib/types";

const NOW = 1_700_000_100_000;

function key(o: Partial<AnswerKey> = {}): AnswerKey {
  return {
    assignmentId: "a1", status: "ready", sourcePdfPath: "files/a1/key/k.pdf", sourceFilename: "key.pdf", sourceSha256: "sha", sourcePageCount: 2,
    documentKind: "answer_key", teacherNotes: "", aiNotes: "Check item 4.", revision: 2, approvedRevision: null, fingerprint: "fp",
    errorMessage: null, aiModel: "fake", usage: null, processingStartedAt: NOW - 60_000, processingFinishedAt: NOW - 30_000, updatedAt: NOW - 30_000,
    ...o,
  };
}

const COUNTS: StatusCounts = { queued: 0, grading: 0, graded: 0, needs_review: 0, failed: 0, total: 0 };

const WORKER: WorkerStatus = {
  state: "running", reason: null, aiMode: "fake", queued: 0, running: 0, keyIssue: null, concurrency: 2, effectiveConcurrency: 2,
  throttledUntil: null,
};

function question(o: Partial<KeyQuestion> = {}): KeyQuestion {
  return {
    id: "q1", assignmentId: "a1", position: 0, kind: "missing_answer", itemLabel: "4", question: "What should 4 show?",
    suggestedAnswer: "A cell", choices: [], status: "pending", answer: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, ...o,
  };
}

function input(o: Partial<AssignmentLiveInput> = {}): AssignmentLiveInput {
  return {
    now: NOW,
    assignment: { id: "a1", title: "Untitled quiz", kind: "quiz" },
    key: key(),
    items: [
      makeKeyItem({ id: "i1", label: "1", pointsCenti: 200, answerSource: "key", aiConfidence: "high" }),
      makeKeyItem({ id: "i2", label: "2", pointsCenti: 150, answerSource: "ai_proposed", aiConfidence: "low" }),
      makeKeyItem({ id: "i3", label: "3", pointsCenti: 100, answerSource: "key", aiConfidence: "medium" }),
    ],
    approved: false,
    locked: false,
    typicalExtractionMs: 45_000,
    questions: [question()],
    board: [],
    counts: COUNTS,
    progress: null,
    worker: WORKER,
    highlighted: [],
    scans: [],
    ...o,
  };
}

describe("buildAssignmentLiveSnapshot", () => {
  it("summarizes the key and carries the AI's questions", () => {
    const s = buildAssignmentLiveSnapshot(input());
    expect(s.serverNow).toBe(NOW);
    expect(s.assignment).toEqual({ id: "a1", title: "Untitled quiz", kind: "quiz" });
    expect(s.key).toEqual({
      status: "ready", approved: false, updatedAt: NOW - 30_000, itemCount: 3, totalPointsCenti: 450, aiProposedCount: 1, uncertainCount: 2,
      pageCount: 2, filename: "key.pdf", errorMessage: null, aiNotes: "Check item 4.", instructions: "", locked: false, extraction: null,
    });
    expect(s.questions).toEqual([{
      id: "q1", kind: "missing_answer", itemLabel: "4", question: "What should 4 show?", suggestedAnswer: "A cell", choices: [], status: "pending",
      answer: null,
    }]);
    // Nothing internal leaks: no stored paths or hashes.
    expect(JSON.stringify(s)).not.toContain("files/a1");
    expect(JSON.stringify(s)).not.toContain("sha");
  });

  it("times a key being read and reports a failed one's reason", () => {
    const reading = buildAssignmentLiveSnapshot(input({ key: key({ status: "processing", processingStartedAt: NOW - 5000, errorMessage: "old" }) }));
    expect(reading.key.extraction).toEqual({ startedAt: NOW - 5000, typicalMs: 45_000 });
    expect(reading.key.errorMessage).toBeNull();
    const noStart = buildAssignmentLiveSnapshot(input({ key: key({ status: "processing", processingStartedAt: null, updatedAt: NOW - 7000 }) }));
    expect(noStart.key.extraction?.startedAt).toBe(NOW - 7000);
    const failed = buildAssignmentLiveSnapshot(input({ key: key({ status: "failed", errorMessage: "Not a key." }) }));
    expect(failed.key).toMatchObject({ errorMessage: "Not a key.", extraction: null });
  });

  it("lists the latest finished current papers, newest first, with their section and score", () => {
    const board: BoardGroup[] = [
      {
        key: "p1", label: "Period 1", rows: [
          { current: makeSubmission({ id: "s1", studentName: "Ana", status: "graded", scoreEarnedCenti: 800, scoreMaxCenti: 1000, gradedAt: NOW - 3000 }), earlier: [] },
          { current: makeSubmission({ id: "s2", studentName: null, status: "needs_review", scoreEarnedCenti: 500, scoreMaxCenti: 1000, gradedAt: NOW - 1000 }), earlier: [] },
          { current: makeSubmission({ id: "s3", studentName: "Bo", status: "grading" }), earlier: [] },
        ],
      },
      {
        key: "none", label: "No section", rows: [
          { current: makeSubmission({ id: "s4", studentName: "Cy", status: "failed", scoreEarnedCenti: null, gradedAt: null, updatedAt: NOW - 2000 }), earlier: [] },
        ],
      },
    ];
    const s = buildAssignmentLiveSnapshot(input({ board }));
    expect(s.recentPapers).toEqual([
      { submissionId: "s2", name: "No name", section: "Period 1", status: "needs_review", scoreEarnedCenti: 500, scoreMaxCenti: 1000, percentTenths: 500, finishedAt: NOW - 1000 },
      { submissionId: "s4", name: "Cy", section: "No section", status: "failed", scoreEarnedCenti: null, scoreMaxCenti: null, percentTenths: null, finishedAt: NOW - 2000 },
      { submissionId: "s1", name: "Ana", section: "Period 1", status: "graded", scoreEarnedCenti: 800, scoreMaxCenti: 1000, percentTenths: 800, finishedAt: NOW - 3000 },
    ]);
  });

  it("keeps at most LIVE_RECENT_PAPERS papers", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      current: makeSubmission({ id: `s${i}`, status: "graded", scoreEarnedCenti: 100, scoreMaxCenti: 100, gradedAt: NOW - i * 1000 }), earlier: [],
    }));
    const s = buildAssignmentLiveSnapshot(input({ board: [{ key: "none", label: "No section", rows }] }));
    expect(s.recentPapers.map((p) => p.submissionId)).toEqual(Array.from({ length: LIVE_RECENT_PAPERS }, (_, i) => `s${i}`));
  });

  it("carries the struggling questions, the pending scans and the worker's state", () => {
    const scan = (o: Partial<Scan>): Scan => ({
      id: "c1", assignmentId: "a1", status: "splitting", splitMode: "one_pass", pagesPerPaper: null, splitGeneration: 1, pdfPath: "files/x.pdf",
      originalFilename: "class.pdf", contentSha256: "h", byteSize: 1, pageCount: 9, readings: [], pagesRead: 3, layout: null, proposedLayout: null,
      statusNote: null, errorMessage: null, aiModel: null, usage: null, createdCount: null, duplicateCount: null, createdAt: NOW, updatedAt: NOW,
      splitStartedAt: NOW - 1000, splitFinishedAt: null, autoGraded: false, onePass: null, ...o,
    });
    const progress = { splitStartedAt: NOW - 1000, pagesRead: 3, pageCount: 9, etaMs: 6000, papersGraded: 3 };
    const s = buildAssignmentLiveSnapshot(input({
      highlighted: [{ item: { id: "i2", label: "2", prompt: "Solve." }, missedTenths: 700, missedPapers: 7, judged: 10 }],
      scans: [
        { scan: scan({}), progress },
        { scan: scan({ id: "c2", status: "done", createdCount: 4 }), progress: null },
        { scan: scan({ id: "c3", status: "failed", splitMode: "auto", errorMessage: "Unreadable." }), progress: null },
      ],
      worker: { ...WORKER, throttledUntil: NOW + 5000 },
    }));
    expect(s.struggling).toEqual([{ itemId: "i2", label: "2", prompt: "Solve.", missedTenths: 700, missedPapers: 7, judged: 10 }]);
    expect(s.scans).toEqual([
      { id: "c1", status: "splitting", splitMode: "one_pass", filename: "class.pdf", pageCount: 9, papers: 3, progress, errorMessage: null },
      { id: "c3", status: "failed", splitMode: "auto", filename: "class.pdf", pageCount: 9, papers: null, progress: null, errorMessage: "Unreadable." },
    ]);
    expect(s.worker).toEqual({ halted: false, throttledUntil: NOW + 5000 });
    expect(buildAssignmentLiveSnapshot(input({ worker: null })).worker.halted).toBe(true);
    expect(buildAssignmentLiveSnapshot(input({ worker: { ...WORKER, state: "paused" } })).worker.halted).toBe(true);
  });
});

describe("assignmentLiveSignature", () => {
  const progress: GradingProgress = {
    done: 1, total: 6, queued: 3, grading: 2, startedAt: NOW - 10_000, typicalPaperMs: 5000, etaMs: 9000, onePass: null,
  };

  it("ignores the clock and the estimates that only shrink with it", () => {
    const a = buildAssignmentLiveSnapshot(input({ progress }));
    const later = buildAssignmentLiveSnapshot(input({ now: NOW + 1000, progress: { ...progress, etaMs: 8000 } }));
    expect(assignmentLiveSignature(later)).toBe(assignmentLiveSignature(a));
  });

  it("changes with anything the page shows", () => {
    const base = assignmentLiveSignature(buildAssignmentLiveSnapshot(input({ progress })));
    const changes: Array<Partial<AssignmentLiveInput>> = [
      { progress: { ...progress, done: 2, queued: 2 } },
      { assignment: { id: "a1", title: "Plants", kind: "quiz" } },
      { questions: [question({ status: "answered", answer: "A cell" })] },
      { key: key({ updatedAt: NOW }) },
      { approved: true },
      { counts: { ...COUNTS, graded: 1, total: 1 } },
      { worker: { ...WORKER, state: "paused" } },
    ];
    for (const change of changes) {
      expect(assignmentLiveSignature(buildAssignmentLiveSnapshot(input({ progress, ...change })))).not.toBe(base);
    }
  });
});

describe("the dashboard snapshot", () => {
  const view: DashboardView = {
    assignments: [{
      id: "a1", title: "Quiz", kind: "quiz", keyStatus: "ready", keyApproved: true, counts: { ...COUNTS, graded: 2, total: 2 },
      scans: { splitting: 0, onePass: 0, review: 0, failed: 0, firstReviewId: null }, createdAt: NOW, progress: null,
    }],
  };

  it("carries each card's moving parts, and its signature ignores the clock", () => {
    const s = buildDashboardLiveSnapshot(view, NOW);
    expect(s).toEqual({
      serverNow: NOW,
      assignments: [{
        id: "a1", title: "Quiz", keyStatus: "ready", keyApproved: true, counts: { ...COUNTS, graded: 2, total: 2 }, progress: null,
        scans: { splitting: 0, review: 0, failed: 0 },
      }],
    });
    const busy = buildDashboardLiveSnapshot({ assignments: [{ ...view.assignments[0], progress: { done: 1, total: 3 } }] }, NOW + 1);
    expect(dashboardLiveSignature(busy)).not.toBe(dashboardLiveSignature(s));
    expect(dashboardLiveSignature(buildDashboardLiveSnapshot(view, NOW + 5000))).toBe(dashboardLiveSignature(s));
  });
});
