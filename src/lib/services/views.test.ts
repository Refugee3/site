import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import type { GradingOutput } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { resetConfigForTests } from "@/lib/config";
import { updateLesson } from "@/lib/db/repos/lessons";
import { setStoredApiKey } from "@/lib/db/repos/settings";
import { getSubmission, getSubmissionByReceipt, setItemOverride, updateSubmission } from "@/lib/db/repos/submissions";
import { setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { answeringGrader, drainQueue, FAKE_META, scriptedGrader } from "@/lib/jobs/test-utils";
import { everyNLayout } from "@/lib/scan-layout";
import { rotateShareCode, setFeedbackReleased } from "@/lib/services/assignments";
import { saveApiKey, setStudentUploads } from "@/lib/services/settings";
import { deleteSubmission, ingestStudentUpload, markReviewed, regradeSubmission, saveItemOverride } from "@/lib/services/submissions";
import {
  buildGradesCsv, estimateCostUsd, getAssignmentHeader, getBoardView, getDashboardView, getKeyEditorView, getLessonsView,
  getReceiptView, getReviewView, getScanReviewView, getSettingsView, getStudentUploadView, getTeacherSettingsView, getUploadPageView,
} from "@/lib/services/views";
import type { AiUsage, Assignment, KeyItem, Submission, SubmissionStatus, Teacher } from "@/lib/types";
import {
  enableStudentUploads, makePdf, seedApprovedKey, seedAssignment, seedLesson, seedScan, seedSubmission, seedTeacher, useTestDb,
} from "@/test/helpers";

const T0 = 1_700_000_000_000;
const ORIGIN = "https://school.test";
let clock = T0;
let teacher: Teacher;
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
  useTestDb();
  enableStudentUploads();
  teacher = seedTeacher({ displayName: "Ms. Rivera" });
  assignment = seedAssignment(teacher.id, { status: "open", title: "Unit 4: Ratios & Rates!" });
  items = seedApprovedKey(assignment.id, [
    { label: "1" },
    { label: "2a", groupLabel: "2", pointsCenti: 200 },
    { label: "2b", groupLabel: "2" },
  ]);
});

/**
 * Uploads a paper (one minute after the previous one) and grades it with every answer correct, under
 * `name`; `output` adjusts the AI's answer.
 */
async function gradedPaper(name: string | null, label = name ?? "anonymous", output: Partial<GradingOutput> = {}): Promise<Submission> {
  clock += 60_000;
  const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1, { label }) }]);
  await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
    student: { name },
    items: refs.map((ref) => makeOutputItem(ref, { what_student_did: `You answered ${ref}.`, feedback: `Feedback for ${ref}.` })),
    overall_feedback: "Well done.",
    ...output,
  })));
  return getSubmissionByReceipt(receiptUrl.slice("/r/".length))!;
}

const PAGES_MISSING: Partial<GradingOutput> = { document_check: { match: "matches", pages_appear_missing: true, note: "" } };

describe("getReceiptView", () => {
  const cases: Array<{ status: SubmissionStatus; released: boolean; phase: string }> = [
    { status: "queued", released: true, phase: "processing" },
    { status: "grading", released: true, phase: "processing" },
    { status: "failed", released: true, phase: "problem" },
    { status: "graded", released: false, phase: "checked" },
    { status: "needs_review", released: false, phase: "checked" },
    { status: "needs_review", released: true, phase: "checked" },
    { status: "graded", released: true, phase: "released" },
  ];

  it.each(cases)("$status with release=$released is $phase", async ({ status, released, phase }) => {
    const paper = await gradedPaper("Maria Lopez");
    updateSubmission(paper.id, { status });
    if (released) setFeedbackReleased(assignment, true);

    const view = getReceiptView(paper.receiptToken)!;
    expect(view.phase).toBe(phase);
    expect(view.result === null).toBe(phase !== "released");
  });

  it("shows the released result grouped by question, with the teacher's feedback over the AI's", async () => {
    const paper = await gradedPaper("Maria Lopez");
    setItemOverride(paper.id, items[1].id, { overrideCenti: 150, overrideFeedback: "Check your units." });
    setFeedbackReleased(assignment, true);

    const view = getReceiptView(paper.receiptToken)!;
    expect(view).toMatchObject({
      assignmentTitle: "Unit 4: Ratios & Rates!", pageCount: 1, notices: [],
      pdfUrl: `/api/r/${paper.receiptToken}/pdf`, detectedName: "Maria Lopez",
    });
    expect(view.result).toEqual({
      earnedCenti: 350, maxCenti: 400, percentTenths: 875, overallFeedback: "Well done.",
      groups: [
        { groupLabel: "", items: [{ label: "1", earnedCenti: 100, maxCenti: 100, whatStudentDid: "You answered Q1.", feedback: "Feedback for Q1." }] },
        {
          groupLabel: "2",
          items: [
            { label: "2a", earnedCenti: 150, maxCenti: 200, whatStudentDid: "You answered Q2.", feedback: "Check your units." },
            { label: "2b", earnedCenti: 100, maxCenti: 100, whatStudentDid: "You answered Q3.", feedback: "Feedback for Q3." },
          ],
        },
      ],
    });
  });

  it("shows the teacher's \"what you did\" note instead of the AI's, and hides it when the teacher emptied it", async () => {
    const paper = await gradedPaper("Maria Lopez");
    saveItemOverride(paper, items[0].id, { pointsCenti: null, feedback: null, whatStudentDid: "You found x = 4." });
    saveItemOverride(paper, items[2].id, { pointsCenti: null, feedback: null, whatStudentDid: "" });
    setFeedbackReleased(assignment, true);

    const groups = getReceiptView(paper.receiptToken)!.result!.groups;
    expect(groups.flatMap((group) => group.items.map((item) => item.whatStudentDid))).toEqual(["You found x = 4.", "You answered Q2.", ""]);
  });

  it("drops the warnings once the teacher has reviewed and accepted the paper", async () => {
    const paper = await gradedPaper("Maria Lopez", "maria", PAGES_MISSING);
    expect(getReceiptView(paper.receiptToken)).toMatchObject({ phase: "checked", notices: ["pages_missing"] });

    markReviewed(paper);

    expect(getReceiptView(paper.receiptToken)).toMatchObject({ phase: "checked", notices: [] });
  });

  it("never reveals the assignment's current share code", async () => {
    const paper = await gradedPaper(null);
    const rotated = rotateShareCode(assignment);
    const view = getReceiptView(paper.receiptToken)!;
    expect(view.notices).toEqual(["no_name"]);
    expect(JSON.stringify(view)).not.toContain(rotated.shareCode);
    expect(JSON.stringify(view)).not.toContain(assignment.shareCode);
  });

  it("lists notices from the flags only while the paper is checked", async () => {
    const paper = await gradedPaper(null);
    updateSubmission(paper.id, { status: "needs_review", flags: ["name_missing", "pages_missing", "low_confidence"] });

    expect(getReceiptView(paper.receiptToken)).toMatchObject({ phase: "checked", detectedName: null, notices: ["no_name", "pages_missing"] });
    updateSubmission(paper.id, { status: "queued" });
    expect(getReceiptView(paper.receiptToken)!.notices).toEqual([]);
  });

  it("returns null for an unknown token", () => {
    expect(getReceiptView("x".repeat(43))).toBeNull();
  });
});

describe("buildGradesCsv", () => {
  it("has one row per current paper in board order, after the pinned columns and one column per item", async () => {
    await gradedPaper("Maria Lopez", "maria-1");
    await gradedPaper("Ana Diaz");
    const resubmission = await gradedPaper("Maria Lopez", "maria-2");
    clock += 60_000;
    await ingestStudentUpload(assignment.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1, { label: "queued" }) }]);

    const { filename, csv } = buildGradesCsv(assignment, ORIGIN);

    expect(filename).toBe("unit-4-ratios-rates-grades.csv");
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe([
      "Section", "Student name", "Status", "Points earned", "Points possible", "Percent", "Completion %", "Accuracy %", "Reviewed",
      "Flags", "Overall feedback", "Submitted at", "Earlier attempts", "Receipt link", "1 (1 pt)", "2a (2 pt)", "2b (1 pt)",
    ].map((cell) => `"${cell}"`).join(","));
    expect(lines).toHaveLength(4); // header, Diaz, Lopez (newest attempt only), the unnamed queued paper
    expect(lines[1]).toContain('"Ana Diaz","Graded","4","4","100%","100%","100%","",""');
    expect(lines[1]).toContain(`Z","","${ORIGIN}/r/`); // no earlier attempts
    expect(lines[2]).toContain(`"Maria Lopez","Graded"`);
    expect(lines[2]).toContain(`Z","1","${ORIGIN}/r/${resubmission.receiptToken}","1","2","1"`);
    expect(lines[3]).toMatch(/^"No section","","Queued","","","","","",/);
  });

  it("keeps two students who both wrote only the same first name as two rows", async () => {
    const first = await gradedPaper("Maria", "maria-a");
    const second = await gradedPaper("Maria", "maria-b");

    const lines = buildGradesCsv(assignment, ORIGIN).csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(getBoardView(assignment, "all").groups[0].rows.map((row) => [row.submissionId, row.earlier.length])).toEqual([
      [first.id, 0], [second.id, 0],
    ]);
  });
});

describe("teacher views", () => {
  it("builds the board with collapsed resubmissions, cached scores and filters", async () => {
    const first = await gradedPaper("Maria Lopez", "maria-1");
    const latest = await gradedPaper("Maria Lopez", "maria-2");
    const flagged = await gradedPaper(null);
    expect(flagged.status).toBe("needs_review");

    const board = getBoardView(assignment, "all");
    expect(board.groups).toHaveLength(1);
    expect(board.groups[0].rows.map((row) => [row.displayName, row.submissionId])).toEqual([
      ["Maria Lopez", latest.id], ["No name", flagged.id],
    ]);
    expect(board.groups[0].rows[0]).toMatchObject({
      scoreEarnedCenti: 400, scoreMaxCenti: 400, percentTenths: 1000, stale: false,
      earlier: [{ submissionId: first.id, createdAt: first.createdAt, status: "graded" }],
    });
    // Counts cover the rows the board shows: the folded earlier attempt is not counted.
    expect(board).toMatchObject({ counts: { graded: 1, needs_review: 1, total: 2 }, active: false, open: true, staleCount: 0 });
    expect(getBoardView(assignment, "needs_review").groups[0].rows.map((row) => row.submissionId)).toEqual([flagged.id]);
    expect(getBoardView(assignment, "failed").groups).toEqual([]);
  });

  it("builds the review page with navigation and earlier attempts", async () => {
    const first = await gradedPaper("Maria Lopez", "maria-1");
    const latest = await gradedPaper("Maria Lopez", "maria-2");
    const flagged = await gradedPaper(null);

    const view = getReviewView(getSubmission(latest.id)!, assignment, ORIGIN);
    expect(view).toMatchObject({
      prevId: null, nextId: flagged.id, nextNeedsReviewId: flagged.id, stale: false, sectionLabel: null,
      pdfUrl: `/api/teacher/submissions/${latest.id}/pdf`, receiptUrl: `${ORIGIN}/r/${latest.receiptToken}`,
      earlierAttempts: [{ submissionId: first.id, createdAt: first.createdAt, status: "graded" }],
    });
    expect(view.items.map((item) => [item.item.label, item.score.earnedCenti])).toEqual([["1", 100], ["2a", 200], ["2b", 100]]);
    expect(getReviewView(getSubmission(first.id)!, assignment, ORIGIN).earlierAttempts).toEqual([]);
  });

  it("does not ask for a review of an earlier attempt that a clean resubmission replaced", async () => {
    const earlier = await gradedPaper("Maria Lopez", "maria-1", PAGES_MISSING);
    expect(earlier.status).toBe("needs_review");
    const resubmission = await gradedPaper("Maria Lopez", "maria-2");

    const counts = { needs_review: 0, graded: 1, total: 1 };
    expect(getBoardView(assignment, "needs_review")).toMatchObject({ counts, groups: [] });
    expect(getAssignmentHeader(assignment, ORIGIN).counts).toMatchObject(counts);
    expect(getDashboardView(teacher).assignments[0].counts).toMatchObject(counts);
    expect(getBoardView(assignment, "all").groups[0].rows[0]).toMatchObject({
      submissionId: resubmission.id, earlier: [{ submissionId: earlier.id, status: "needs_review" }],
    });
  });

  it("builds the assignment header", async () => {
    await gradedPaper("Maria Lopez");
    const header = getAssignmentHeader(assignment, ORIGIN);
    expect(header).toEqual({
      assignment, shareUrl: `${ORIGIN}/s/${assignment.shareCode}`, keyStatus: "ready", keyApproved: true, itemCount: 3,
      totalPointsCenti: 400, counts: { queued: 0, grading: 0, graded: 1, needs_review: 0, failed: 0, total: 1 }, canOpen: false,
      studentsCanUpload: true,
    });
  });

  it("adds up every AI call in the settings usage: regrades, refusals and deleted papers included", async () => {
    const usage: AiUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 };
    const billed = scriptedGrader({
      async gradeSubmission(input) {
        const refs = input.items.map((_item, index) => `Q${index + 1}`);
        return { output: makeGradingOutput(refs), refs, keyPdfIncluded: false, meta: { ...FAKE_META, servedModel: "claude-opus-5-5", usage } };
      },
    });
    const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1) }]);
    await drainQueue(billed);
    const paper = getSubmissionByReceipt(receiptUrl.slice("/r/".length))!;
    regradeSubmission(paper);
    await drainQueue(billed);
    regradeSubmission(getSubmission(paper.id)!);
    await drainQueue(scriptedGrader({
      async gradeSubmission() {
        throw new AiError("refusal", "The AI declined to answer.", { retryable: false, billed: { servedModel: "claude-opus-5-5", usage } });
      },
    }));
    // The refusal keeps its own (billed) usage instead of erasing the paper's.
    expect(getSubmission(paper.id)).toMatchObject({ status: "needs_review", flags: ["ai_refused"], usage });
    await deleteSubmission(getSubmission(paper.id)!);

    const { usage: totals } = getSettingsView(assignment);
    expect(totals).toMatchObject({ calls: 3, papers: 0, inputTokens: 3000, outputTokens: 600, cacheReadTokens: 9000, cacheWriteTokens: 0 });
    expect(totals.estimatedCostUsd).toBeCloseTo(3 * estimateCostUsd(usage, "claude-opus-5-5", "1h")!);
  });

  it("estimates the settings cost from the models that answered", async () => {
    await gradedPaper("Maria Lopez");
    expect(getSettingsView(assignment)).toEqual({
      sectionsText: "",
      usage: { calls: 1, papers: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    });
  });

  it("estimates cost for the known model only", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 500_000 };
    expect(estimateCostUsd(usage, "claude-opus-5-5", "1h")).toBeCloseTo(4 + 2 + 0.4 + 4);
    expect(estimateCostUsd(usage, "claude-opus-5-5", "5m")).toBeCloseTo(4 + 2 + 0.4 + 2.5);
    expect(estimateCostUsd(usage, "some-other-model", "1h")).toBeNull();
  });
});

describe("getStudentUploadView", () => {
  it("shows what a student needs before uploading", () => {
    expect(getStudentUploadView(assignment.shareCode)).toEqual({
      code: assignment.shareCode, title: "Unit 4: Ratios & Rates!", instructions: "", teacherName: "Ms. Rivera", status: "open",
      accepting: true, maxUploadMb: 20, maxPages: 40, maxFiles: 20,
    });
    expect(getStudentUploadView("ZZZZZZ")).toBeNull();
  });
});

describe("with student uploads turned off", () => {
  beforeEach(() => {
    setStudentUploads(false);
  });

  it("an open assignment accepts nothing, and nothing offers to open one", async () => {
    const draft = seedAssignment(teacher.id);
    seedApprovedKey(draft.id, [{ label: "1" }]);

    expect(getStudentUploadView(assignment.shareCode)).toMatchObject({ status: "open", accepting: false });
    expect(getBoardView(assignment, "all")).toMatchObject({ open: false, studentsCanUpload: false });
    expect(getAssignmentHeader(draft, ORIGIN)).toMatchObject({ keyApproved: true, canOpen: false, studentsCanUpload: false });
    expect(getDashboardView(teacher).studentsCanUpload).toBe(false);
    expect(getKeyEditorView(assignment).studentsCanUpload).toBe(false);
  });

  it("receipts keep working but don't ask the student to submit again", async () => {
    enableStudentUploads();
    const paper = await gradedPaper("Maria Lopez");
    setStudentUploads(false);

    expect(getReceiptView(paper.receiptToken)).toMatchObject({ phase: "checked", canResubmit: false });
    enableStudentUploads();
    expect(getReceiptView(paper.receiptToken)!.canResubmit).toBe(true);
  });

  it("offers to open a draft with an approved key again once they are on", () => {
    const draft = seedAssignment(teacher.id);
    seedApprovedKey(draft.id, [{ label: "1" }]);
    enableStudentUploads();
    expect(getAssignmentHeader(draft, ORIGIN)).toMatchObject({ canOpen: true, studentsCanUpload: true });
  });
});

describe("guidance in the teacher views", () => {
  it("counts the current, unreviewed papers graded before the latest guidance on the board", async () => {
    await gradedPaper("Maria Lopez", "maria-1");
    await gradedPaper("Maria Lopez", "maria-2");
    const flagged = await gradedPaper(null);
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(0);

    setGradingPreferences(teacher.id, "Ignore spelling.");
    // Maria's earlier attempt is folded under her newest one and is not counted.
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(2);
    markReviewed(getSubmission(flagged.id)!);
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(1);
  });

  it("shows each item's lesson and whether the paper was graded before the latest guidance", async () => {
    const paper = await gradedPaper("Maria Lopez");
    expect(getReviewView(getSubmission(paper.id)!, assignment, ORIGIN).guidanceStale).toBe(false);

    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit without units." });

    const view = getReviewView(getSubmission(paper.id)!, assignment, ORIGIN);
    expect(view.items.map((item) => item.lesson)).toEqual([
      { id: expect.any(String), reason: "Half credit without units.", active: true }, null, null,
    ]);
    expect(view.guidanceStale).toBe(true);
  });

  it("lists lessons by key item, newest first, with why any is not sent", () => {
    const papers = Array.from({ length: 7 }, () => seedSubmission(assignment.id, { status: "graded" }));
    const lesson = (paper: Submission, item: KeyItem, o: Partial<Parameters<typeof seedLesson>[0]> = {}) => {
      clock += 1000;
      return seedLesson({ assignmentId: assignment.id, submissionId: paper.id, itemId: item.id, reason: "A reason.", ...o });
    };
    const onFirst = papers.slice(0, 6).map((paper) => lesson(paper, items[0]));
    const off = lesson(papers[6], items[1], { active: false });
    const agrees = lesson(papers[5], items[2], { teacherAttempt: "complete", teacherCorrectness: "incorrect", reason: "" });
    const unread = lesson(papers[6], items[2], {
      aiAttempt: null, aiCorrectness: null, teacherAttempt: null, teacherCorrectness: null, overrideCenti: null, feedback: "See me.",
    });

    const view = getLessonsView(assignment);

    expect(view.lessons.map((entry) => [entry.lesson.id, entry.itemLabel, entry.itemPosition, entry.sent, entry.notSent])).toEqual([
      ...[...onFirst].reverse().map((l, i) => [l.id, "1", 0, i < 5, i < 5 ? null : "limit"]),
      [off.id, "2a", 1, false, "inactive"],
      [unread.id, "2b", 2, false, "no_reading"],
      [agrees.id, "2b", 2, false, "agrees"],
    ]);
    expect(view.lessons[0]).toMatchObject({
      itemMaxCenti: 100, paperHref: `/teacher/assignments/${assignment.id}/submissions/${papers[5].id}`,
    });
    expect(view).toMatchObject({ activeCount: 8, sentCount: 5, hasPreferences: false });
  });

  it("counts the papers a regrade with the latest guidance would cover, and links lessons only to papers that still exist", async () => {
    const paper = await gradedPaper("Maria Lopez");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit." });
    setGradingPreferences(teacher.id, "Ignore spelling.");
    expect(getLessonsView(assignment)).toMatchObject({ guidanceStaleCount: 1, sentCount: 1, activeCount: 1, hasPreferences: true });

    const [entry] = getLessonsView(assignment).lessons;
    updateLesson(entry.lesson.id, { active: false });
    await deleteSubmission(getSubmission(paper.id)!);

    expect(getLessonsView(assignment)).toMatchObject({
      lessons: [{ sent: false, notSent: "inactive", paperHref: null }], guidanceStaleCount: 0, sentCount: 0, activeCount: 0,
    });
  });
});

describe("upload and scan views", () => {
  it("describes the upload page with the scans, newest first", async () => {
    const view = getUploadPageView(assignment);
    expect(view).toEqual({
      keyApproved: true, keyPageCount: null, scans: [], maxUploadMb: 20, maxPages: 40, maxScanMb: 100, maxScanPages: 200,
      studentsCanUpload: true,
    });

    const older = await seedScan(assignment.id, { pages: 4 });
    clock += 1000;
    const newer = await seedScan(assignment.id, { pages: 6, status: "done" });
    seedApprovedKey(assignment.id, [{ label: "1", page: 1 }, { label: "2", page: 2 }]);

    expect(getUploadPageView(assignment)).toMatchObject({
      keyPageCount: 2,
      scans: [
        { id: newer.id, status: "done", originalFilename: "scan.pdf", pageCount: 6, createdAt: newer.createdAt, createdCount: null },
        { id: older.id, status: "splitting", pageCount: 4 },
      ],
    });
  });

  it("describes a scan for review without its stored path, hash or AI accounting", async () => {
    const layout = everyNLayout(6, 3);
    const scan = await seedScan(assignment.id, { pages: 6, status: "review", splitMode: "every", pagesPerPaper: 3, layout });
    seedSubmission(assignment.id);
    const limited = { ...assignment, maxSubmissions: 4 };

    const view = getScanReviewView(scan, limited);

    expect(view).toMatchObject({
      pdfUrl: `/api/teacher/scans/${scan.id}/pdf`, keyApproved: true, keyPageCount: null, maxPagesPerPaper: 40, remainingSubmissions: 3,
      scan: { id: scan.id, status: "review", splitMode: "every", pagesPerPaper: 3, pageCount: 6, layout, proposedLayout: layout },
    });
    for (const hidden of ["pdfPath", "contentSha256", "aiModel", "usage"]) expect(view.scan).not.toHaveProperty(hidden);
    expect(getScanReviewView(scan, { ...assignment, maxSubmissions: 1 }).remainingSubmissions).toBe(0);
  });
});

describe("getTeacherSettingsView", () => {
  const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-a1b2";

  it("shows no key, the student switch and the teacher's preferences", () => {
    setGradingPreferences(teacher.id, "Ignore spelling.");
    expect(getTeacherSettingsView(teacher)).toEqual({
      apiKey: { source: "none", masked: null, check: null, setAt: null, setByName: null, unreadable: false, envKeySet: false },
      aiMode: "fake", model: "claude-opus-5-5", studentsCanUpload: true, gradingPreferences: "Ignore spelling.", worker: null,
    });
  });

  it("falls back to the server's ANTHROPIC_API_KEY", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server-key-0000000000000000");
    resetConfigForTests();
    expect(getTeacherSettingsView(teacher).apiKey).toMatchObject({ source: "env", masked: null, envKeySet: true });
  });

  it("shows a saved key only masked, with who saved it and when", async () => {
    await saveApiKey(teacher, KEY, async () => "unreachable");

    const view = getTeacherSettingsView(seedTeacher());

    expect(view.apiKey).toEqual({
      source: "app", masked: "sk-ant-…a1b2", check: "unverified", setAt: T0, setByName: "Ms. Rivera", unreadable: false, envKeySet: false,
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("says when the saved key can't be decrypted, and falls back like the grader does", () => {
    setStoredApiKey({ ciphertext: "v1.AAAA.AAAA.AAAA", masked: "sk-ant-…a1b2", check: "verified", setBy: teacher.id });
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server-key-0000000000000000");
    resetConfigForTests();

    expect(getTeacherSettingsView(teacher).apiKey).toEqual({
      source: "env", masked: null, check: null, setAt: null, setByName: null, unreadable: true, envKeySet: true,
    });
  });
});
