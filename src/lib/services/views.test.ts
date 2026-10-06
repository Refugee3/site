import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getSubmission, getSubmissionByReceipt, setItemOverride, updateSubmission } from "@/lib/db/repos/submissions";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { answeringGrader, drainQueue } from "@/lib/jobs/test-utils";
import { setFeedbackReleased } from "@/lib/services/assignments";
import { ingestStudentUpload } from "@/lib/services/submissions";
import {
  buildGradesCsv, estimateCostUsd, getAssignmentHeader, getBoardView, getReceiptView, getReviewView, getSettingsView,
  getStudentUploadView,
} from "@/lib/services/views";
import type { Assignment, KeyItem, Submission, SubmissionStatus } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
const ORIGIN = "https://school.test";
let clock = T0;
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
  useTestDb();
  assignment = seedAssignment(seedTeacher({ displayName: "Ms. Rivera" }).id, { status: "open", title: "Unit 4: Ratios & Rates!" });
  items = seedApprovedKey(assignment.id, [
    { label: "1" },
    { label: "2a", groupLabel: "2", pointsCenti: 200 },
    { label: "2b", groupLabel: "2" },
  ]);
});

/** Uploads a paper (one minute after the previous one) and grades it with every answer correct, under `name`. */
async function gradedPaper(name: string | null, label = name ?? "anonymous"): Promise<Submission> {
  clock += 60_000;
  const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1, { label }) }]);
  await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
    student: { name },
    items: refs.map((ref) => makeOutputItem(ref, { what_student_did: `You answered ${ref}.`, feedback: `Feedback for ${ref}.` })),
    overall_feedback: "Well done.",
  })));
  return getSubmissionByReceipt(receiptUrl.slice("/r/".length))!;
}

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
      assignmentTitle: "Unit 4: Ratios & Rates!", shareCode: assignment.shareCode, pageCount: 1, notices: [],
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
      "Flags", "Overall feedback", "Submitted at", "Receipt link", "1 (1 pt)", "2a (2 pt)", "2b (1 pt)",
    ].map((cell) => `"${cell}"`).join(","));
    expect(lines).toHaveLength(4); // header, Diaz, Lopez (newest attempt only), the unnamed queued paper
    expect(lines[1]).toContain('"Ana Diaz","Graded","4","4","100%","100%","100%","",""');
    expect(lines[2]).toContain(`"Maria Lopez","Graded"`);
    expect(lines[2]).toContain(`"${ORIGIN}/r/${resubmission.receiptToken}","1","2","1"`);
    expect(lines[3]).toMatch(/^"No section","","Queued","","","","","",/);
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
    expect(board).toMatchObject({ counts: { graded: 2, needs_review: 1, total: 3 }, active: false, open: true, staleCount: 0 });
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

  it("builds the assignment header and the settings usage", async () => {
    await gradedPaper("Maria Lopez");
    const header = getAssignmentHeader(assignment, ORIGIN);
    expect(header).toMatchObject({
      shareUrl: `${ORIGIN}/s/${assignment.shareCode}`, keyStatus: "ready", keyApproved: true, itemCount: 3, totalPointsCenti: 400,
      staleCount: 0, canOpen: false, worker: null,
    });
    expect(getSettingsView(assignment)).toEqual({
      sectionsText: "",
      usage: { papers: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
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
