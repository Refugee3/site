import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ai from "@/lib/ai";
import { AiError } from "@/lib/ai/errors";
import { getGrader, resetGrader } from "@/lib/ai/index";
import type { GradingOutput } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { getDb } from "@/lib/db/connection";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { addAssignmentUsage, getGradingBatchStartedAt } from "@/lib/db/repos/assignments";
import { updateKey } from "@/lib/db/repos/keys";
import { getScan, updateScan } from "@/lib/db/repos/scans";
import { updateLesson } from "@/lib/db/repos/lessons";
import { saveHostedAgentError, setGradingEngine, setStoredApiKey } from "@/lib/db/repos/settings";
import { getSubmission, getSubmissionByReceipt, setItemOverride, updateSubmission } from "@/lib/db/repos/submissions";
import { setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { answeringGrader, drainQueue, FAKE_META, scriptedGrader } from "@/lib/jobs/test-utils";
import { createWorker } from "@/lib/jobs/worker";
import { ingestKeyPdf } from "@/lib/services/keys";
import { everyNLayout } from "@/lib/scan-layout";
import { rotateShareCode, setFeedbackReleased } from "@/lib/services/assignments";
import { removeApiKey, saveApiKey, setAiModel, setStudentUploads } from "@/lib/services/settings";
import {
  deleteSubmission, gradeManually, ingestStudentUpload, markReviewed, regradeSubmission, saveItemOverride,
} from "@/lib/services/submissions";
import {
  AGENT_RUNTIME_USD_PER_HOUR, buildGradesCsv, estimateCostUsd, estimateLedgerCostUsd, getAssignmentHeader, getBoardView,
  getDashboardView, getKeyEditorView, getLessonsView, getReceiptView, getReviewView, getScanReviewView, getSettingsView,
  getStudentUploadView, getTeacherSettingsView, getUploadPageView,
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
  // Saving a key in claude mode starts setting up the hosted agent; nothing here may reach for Anthropic.
  vi.spyOn(ai, "startHostedAgentSetup").mockImplementation(() => undefined);
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
      usage: {
        calls: 1, papers: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0,
        agentSessions: 0, agentActiveSeconds: 0,
      },
    });
  });

  it("estimates cost for the known models only, each at its own price", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 500_000 };
    // Opus 5.5: $4 / $20 per million, cache reads $0.20, cache writes $8 (1 h) or $5 (5 min).
    expect(estimateCostUsd(usage, "claude-opus-5-5", "1h")).toBeCloseTo(4 + 2 + 0.4 + 4);
    expect(estimateCostUsd(usage, "claude-opus-5-5", "5m")).toBeCloseTo(4 + 2 + 0.4 + 2.5);
    // Sonnet 5.5: $2 / $10 per million, cache reads $0.20, cache writes $4 (1 h) or $2.50 (5 min).
    expect(estimateCostUsd(usage, "claude-sonnet-5-5", "1h")).toBeCloseTo(2 + 1 + 0.4 + 2);
    expect(estimateCostUsd(usage, "claude-sonnet-5-5", "5m")).toBeCloseTo(2 + 1 + 0.4 + 1.25);
    // The fallback models a declined request may be served by: Sonnet 5 at Sonnet 5.5's prices, Opus 5 and Opus 4.8 at
    // $5 / $25, cache reads $0.50, cache writes $10 (1 h) or $6.25 (5 min).
    expect(estimateCostUsd(usage, "claude-sonnet-5", "1h")).toBeCloseTo(2 + 1 + 0.4 + 2);
    for (const model of ["claude-opus-5", "claude-opus-4-8"]) {
      expect(estimateCostUsd(usage, model, "1h"), model).toBeCloseTo(5 + 2.5 + 1 + 5);
      expect(estimateCostUsd(usage, model, "5m"), model).toBeCloseTo(5 + 2.5 + 1 + 3.125);
    }
    expect(estimateCostUsd(usage, "some-other-model", "1h")).toBeNull();
  });

  it("prices each model's share of the assignment's usage at that model's own price", () => {
    const usage: AiUsage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    addAssignmentUsage(assignment.id, "claude-sonnet-5-5", usage);
    addAssignmentUsage(assignment.id, "claude-sonnet-5-5", usage);
    addAssignmentUsage(assignment.id, "claude-opus-5-5", usage);

    const view = getSettingsView(assignment).usage;
    expect(view).toMatchObject({ calls: 3, inputTokens: 3_000_000, outputTokens: 300_000 });
    // Sonnet 5.5: 2 × ($2 + $1); Opus 5.5: $4 + $2. Half the price per token, so about half the cost for the same work.
    expect(view.estimatedCostUsd).toBeCloseTo(2 * 3 + 6);
    expect(estimateCostUsd(usage, "claude-sonnet-5-5", "1h")! * 2).toBeCloseTo(estimateCostUsd(usage, "claude-opus-5-5", "1h")!);
  });

  it("prices hosted-agent sessions at their list cost, and estimates them from tokens and running time once one has none", () => {
    const direct: AiUsage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const session: AiUsage = { inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
    addAssignmentUsage(assignment.id, "claude-opus-5-5", direct);
    addAssignmentUsage(assignment.id, "claude-opus-5-5", session, { listCostCents: 175, activeSeconds: 600 });
    addAssignmentUsage(assignment.id, "claude-opus-5-5", session, { listCostCents: 125, activeSeconds: 300 });

    const { usage } = getSettingsView(assignment);
    expect(usage).toMatchObject({
      calls: 3, inputTokens: 1_400_000, outputTokens: 200_000, cacheReadTokens: 2_000_000, agentSessions: 2, agentActiveSeconds: 900,
    });
    // The direct call by its tokens ($4 + $2), the sessions at the list cost Anthropic reported ($1.75 + $1.25).
    expect(usage.estimatedCostUsd).toBeCloseTo(6 + 3);

    addAssignmentUsage(assignment.id, "claude-opus-5-5", session, { listCostCents: null, activeSeconds: 1800 });
    // A session without a reported cost: every session is estimated, $2 of tokens each plus $0.08 per hour of running time.
    expect(estimateCostUsd(session, "claude-opus-5-5", "1h")).toBeCloseTo(2);
    expect(getSettingsView(assignment).usage).toMatchObject({ agentSessions: 3, agentActiveSeconds: 2700 });
    expect(getSettingsView(assignment).usage.estimatedCostUsd).toBeCloseTo(6 + 3 * 2 + 0.75 * AGENT_RUNTIME_USD_PER_HOUR);
  });

  it("prices a model without a known price only by the list cost its hosted-agent sessions reported", () => {
    const none: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const tokens: AiUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const agent = { sessions: 1, ...tokens, listCostCents: 250, unpricedSessions: 0, activeSeconds: 60 };

    expect(AGENT_RUNTIME_USD_PER_HOUR).toBe(0.08);
    expect(estimateLedgerCostUsd("some-other-model", { calls: 1, ...tokens, agent }, "1h")).toBe(2.5);
    expect(estimateLedgerCostUsd("some-other-model", { calls: 1, ...tokens, agent: { ...agent, unpricedSessions: 1 } }, "1h")).toBeNull();
    // A direct call of that model besides the session can't be priced.
    expect(estimateLedgerCostUsd("some-other-model", { calls: 2, ...tokens, inputTokens: 2000, agent }, "1h")).toBeNull();
    // The fake grader's calls use no tokens and cost nothing.
    expect(estimateLedgerCostUsd("fake", { calls: 3, ...none }, "1h")).toBe(0);
  });

  it("tells the review page which engine would grade the paper now", async () => {
    const paper = await gradedPaper("Maria Lopez");
    const engine = () => getReviewView(getSubmission(paper.id)!, assignment, ORIGIN).gradingEngine;
    expect(engine()).toBe("fake");

    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    expect(engine()).toBeNull();
    await saveApiKey(teacher, "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-a1b2", async () => "ok");
    expect(engine()).toBe("direct");
    setGradingEngine("agent");
    expect(engine()).toBe("agent");
    setGradingEngine("direct");
    expect(engine()).toBe("direct");
  });

  it("doesn't mark papers for regrading when the AI model changes", async () => {
    const paper = await gradedPaper("Maria Lopez");
    const before = { board: getBoardView(assignment, "all"), review: getReviewView(getSubmission(paper.id)!, assignment, ORIGIN) };
    expect(before.board).toMatchObject({ staleCount: 0, guidanceStaleCount: 0 });

    setAiModel("claude-opus-5-5");
    setAiModel("claude-sonnet-5-5");

    expect(getBoardView(assignment, "all")).toMatchObject({ staleCount: 0, guidanceStaleCount: 0 });
    const review = getReviewView(getSubmission(paper.id)!, assignment, ORIGIN);
    expect(review).toMatchObject({ stale: false, guidanceStale: false });
    expect(getSubmission(paper.id)).toEqual(before.review.submission);
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
    const untouched = await gradedPaper("Ben Ode");
    expect(getReviewView(getSubmission(paper.id)!, assignment, ORIGIN).guidanceStale).toBe(false);

    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit without units." });

    // The paper the teacher just corrected is not told to regrade with its own correction; an untouched paper is.
    const view = getReviewView(getSubmission(paper.id)!, assignment, ORIGIN);
    expect(view.items.map((item) => item.lesson)).toEqual([
      { id: expect.any(String), reason: "Half credit without units.", active: true, sent: true, notSent: null }, null, null,
    ]);
    expect(view.guidanceStale).toBe(false);
    expect(getReviewView(getSubmission(untouched.id)!, assignment, ORIGIN).guidanceStale).toBe(true);
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(1);
  });

  it("says whether each item's lesson is sent to the grader, and why not", async () => {
    const paper = await gradedPaper("Maria Lopez");
    const lessonOf = (i: number) => getReviewView(getSubmission(paper.id)!, assignment, ORIGIN).items[i].lesson;

    // The AI's own points (2 of 2), with no reason: nothing to learn.
    saveItemOverride(paper, items[1].id, { pointsCenti: 200, feedback: null });
    expect(lessonOf(1)).toMatchObject({ active: true, sent: false, notSent: "agrees" });

    saveItemOverride(paper, items[1].id, { pointsCenti: 200, feedback: null, reason: "Units are optional." });
    expect(lessonOf(1)).toMatchObject({ sent: true, notSent: null });

    // Points no judgment gives exactly are sent even without a reason.
    saveItemOverride(paper, items[0].id, { pointsCenti: 75, feedback: null });
    expect(lessonOf(0)).toMatchObject({ sent: true, notSent: null });

    updateLesson(lessonOf(0)!.id, { active: false });
    expect(lessonOf(0)).toMatchObject({ active: false, sent: false, notSent: "inactive" });
  });

  it("keeps no lesson for a paper graded by hand", () => {
    const paper = seedSubmission(assignment.id, { status: "failed", source: "teacher" });
    gradeManually(paper);

    saveItemOverride(getSubmission(paper.id)!, items[0].id, { pointsCenti: 100, feedback: null, reason: "Full marks." });

    const view = getReviewView(getSubmission(paper.id)!, assignment, ORIGIN);
    expect(view.items[0]).toMatchObject({ result: { overrideCenti: 100, judgment: null }, lesson: null });
  });

  it("lists lessons by key item, newest first, with why any is not sent", () => {
    const papers = Array.from({ length: 7 }, () => seedSubmission(assignment.id, { status: "graded" }));
    const lesson = (paper: Submission, item: KeyItem, o: Partial<Parameters<typeof seedLesson>[0]> = {}) => {
      clock += 1000;
      return seedLesson({ assignmentId: assignment.id, submissionId: paper.id, itemId: item.id, reason: "A reason.", ...o });
    };
    const onFirst = papers.slice(0, 6).map((paper) => lesson(paper, items[0]));
    const off = lesson(papers[6], items[1], { active: false });
    const agrees = lesson(papers[5], items[2], {
      studentAnswer: "x = 5", teacherAttempt: "complete", teacherCorrectness: "incorrect", reason: "",
    });
    const unread = lesson(papers[6], items[2], {
      aiAttempt: null, aiCorrectness: null, teacherAttempt: null, teacherCorrectness: null, overrideCenti: null, feedback: "See me.",
    });
    // Full credit for an answer the AI saw as blank, with no reason: a reading fix, not a ruling on blank answers.
    const readingFix = lesson(papers[4], items[2], { studentAnswer: "", aiAttempt: "none", aiCorrectness: "no_answer", reason: "" });

    const view = getLessonsView(assignment);

    expect(view.lessons.map((entry) => [entry.lesson.id, entry.itemLabel, entry.itemPosition, entry.sent, entry.notSent])).toEqual([
      ...[...onFirst].reverse().map((l, i) => [l.id, "1", 0, i < 5, i < 5 ? null : "limit"]),
      [off.id, "2a", 1, false, "inactive"],
      [readingFix.id, "2b", 2, false, "reading_fix"],
      [unread.id, "2b", 2, false, "no_reading"],
      [agrees.id, "2b", 2, false, "agrees"],
    ]);
    expect(view.lessons[0]).toMatchObject({
      itemMaxCenti: 100, paperHref: `/teacher/assignments/${assignment.id}/submissions/${papers[5].id}`, paperDeleted: false,
    });
    expect(view).toMatchObject({ activeCount: 9, sentCount: 5, hasPreferences: false });
  });

  it("counts the papers a regrade with the latest guidance would cover, and links lessons only to papers that still exist", async () => {
    const paper = await gradedPaper("Maria Lopez");
    const untouched = await gradedPaper("Ben Ode");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit." });
    setGradingPreferences(teacher.id, "Ignore spelling.");
    // Only the untouched paper: the corrected one is left alone.
    expect(getLessonsView(assignment)).toMatchObject({ guidanceStaleCount: 1, sentCount: 1, activeCount: 1, hasPreferences: true });
    expect(getReviewView(getSubmission(untouched.id)!, assignment, ORIGIN).guidanceStale).toBe(true);

    const [entry] = getLessonsView(assignment).lessons;
    updateLesson(entry.lesson.id, { active: false });
    await deleteSubmission(getSubmission(paper.id)!);

    expect(getLessonsView(assignment)).toMatchObject({
      lessons: [{ sent: false, notSent: "inactive", paperHref: null, paperDeleted: true }], guidanceStaleCount: 1, sentCount: 0, activeCount: 0,
    });
  });
});

describe("upload and scan views", () => {
  it("describes the upload page with the scans, newest first", async () => {
    const view = getUploadPageView(assignment);
    expect(view).toEqual({
      keyApproved: true, keyPageCount: null, scans: [], maxUploadMb: 20, maxPages: 40, maxScanMb: 100, maxScanPages: 200,
      studentsCanUpload: true, onePassAvailable: true,
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

  it("counts the scans waiting on the AI or the teacher on the dashboard and the board", async () => {
    const empty = { splitting: 0, onePass: 0, review: 0, failed: 0, firstReviewId: null };
    expect(getDashboardView(teacher).assignments[0].scans).toEqual(empty);
    expect(getBoardView(assignment, "all")).toMatchObject({ scans: empty, active: false });

    clock += 1000;
    const older = await seedScan(assignment.id, { pages: 2, status: "review", writeFile: false });
    clock += 1000;
    await seedScan(assignment.id, { pages: 3, status: "review", writeFile: false });
    await seedScan(assignment.id, { pages: 4, status: "failed", writeFile: false });
    await seedScan(assignment.id, { pages: 5, status: "done", writeFile: false });
    await seedScan(seedAssignment(teacher.id).id, { pages: 6, status: "review", writeFile: false });
    const counts = { splitting: 0, onePass: 0, review: 2, failed: 1, firstReviewId: older.id };
    expect(getDashboardView(teacher).assignments.find((a) => a.id === assignment.id)!.scans).toEqual(counts);
    expect(getBoardView(assignment, "all")).toMatchObject({ scans: counts, active: false });

    // The board polls while a scan is being split, so its papers show up without a reload.
    await seedScan(assignment.id, { pages: 7, status: "splitting", writeFile: false });
    expect(getBoardView(assignment, "all")).toMatchObject({ scans: { ...counts, splitting: 1 }, active: true });
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
      aiMode: "fake", aiModel: "claude-sonnet-5-5", studentsCanUpload: true, openAssignmentCount: 1,
      gradingPreferences: "Ignore spelling.", worker: null, grader: { engine: "direct", agent: null },
    });
  });

  it("shows the AI model chosen in Settings", () => {
    setAiModel("claude-opus-5-5");
    expect(getTeacherSettingsView(teacher).aiModel).toBe("claude-opus-5-5");
  });

  it("shows the grading engine, and the hosted agent's setup for the key in use in claude mode only", async () => {
    await saveApiKey(teacher, KEY, async () => "ok");
    expect(getTeacherSettingsView(teacher).grader).toEqual({ engine: "direct", agent: null });
    setGradingEngine("agent");
    expect(getTeacherSettingsView(teacher).grader).toEqual({ engine: "agent", agent: null });
    setGradingEngine("direct");
    expect(getTeacherSettingsView(teacher).grader).toEqual({ engine: "direct", agent: null });

    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    expect(getTeacherSettingsView(teacher).grader).toEqual({
      engine: "direct", agent: { state: "not_set_up", error: null, checkedAt: null },
    });
    clock += 1000;
    saveHostedAgentError("Anthropic rejected the API key. Replace it above.");
    expect(getTeacherSettingsView(teacher).grader.agent).toEqual({
      state: "error", error: "Anthropic rejected the API key. Replace it above.", checkedAt: T0 + 1000,
    });
  });

  it("shows no hosted agent in claude mode without a usable key", () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    expect(getTeacherSettingsView(teacher).grader).toEqual({ engine: "direct", agent: null });
    setGradingEngine("agent");
    expect(getTeacherSettingsView(teacher).grader).toEqual({ engine: "agent", agent: null });
  });

  it("counts the open assignments of every teacher, which take student uploads as soon as the switch is on", () => {
    seedAssignment(seedTeacher().id, { status: "open" });
    seedAssignment(teacher.id, { status: "closed" });
    seedAssignment(teacher.id);
    setStudentUploads(false);

    expect(getTeacherSettingsView(teacher)).toMatchObject({ studentsCanUpload: false, openAssignmentCount: 2 });
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

  it("lets the teacher remove a saved key that can't be read, leaving the server's ANTHROPIC_API_KEY in use", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_MODE", "claude");
    vi.stubEnv("APP_SECRET", "a".repeat(32));
    resetConfigForTests();
    await saveApiKey(teacher, KEY, async () => "ok");
    // The secret changed since the key was saved; grading runs on the server's key meanwhile.
    vi.stubEnv("APP_SECRET", "b".repeat(32));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server-key-0000000000000000");
    resetConfigForTests();
    resetGrader();
    expect(getTeacherSettingsView(teacher).apiKey).toMatchObject({ source: "env", unreadable: true, envKeySet: true });
    expect(getGrader()?.mode).toBe("claude");

    removeApiKey();

    expect(getTeacherSettingsView(teacher).apiKey).toEqual({
      source: "env", masked: null, check: null, setAt: null, setByName: null, unreadable: false, envKeySet: true,
    });
    expect(getGrader()?.mode).toBe("claude");
  });

  it("shows a saved key as unreadable, instead of failing, when the server can't read its secret key file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    await saveApiKey(teacher, KEY, async () => "ok");
    resetGrader();
    // E.g. a bind mount of a missing host file, which Docker creates as a directory.
    const keyFile = path.join(getConfig().dataDir, "secret.key");
    fs.rmSync(keyFile);
    fs.mkdirSync(keyFile);
    try {
      expect(getTeacherSettingsView(teacher).apiKey).toEqual({
        source: "none", masked: null, check: null, setAt: null, setByName: null, unreadable: true, envKeySet: false,
      });
      expect(getGrader()).toBeNull();
      expect(createWorker({ grader: getGrader, concurrency: 1, pollMs: 1000 }).status()).toMatchObject({ keyIssue: "missing" });
    } finally {
      fs.rmdirSync(keyFile);
    }
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

describe("progress and timing", () => {
  /** Uploads a one-page student paper (queued); returns its id. */
  async function upload(label: string): Promise<string> {
    const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1, { label }) }]);
    return getSubmissionByReceipt(receiptUrl.slice("/r/".length))!.id;
  }

  /** Grades every queued paper, each taking `ms` on the test clock. */
  function slowGrader(ms: number) {
    return scriptedGrader({
      async gradeSubmission(input, options) {
        clock += ms;
        return answeringGrader((refs) => makeGradingOutput(refs)).gradeSubmission(input, options);
      },
    });
  }

  it("shows no progress while nothing is queued or being graded", () => {
    expect(getBoardView(assignment, "all").progress).toBeNull();
    expect(getDashboardView(teacher).assignments[0].progress).toBeNull();
  });

  it("follows the batch on the board and the dashboard, with the typical paper time and an ETA, until it is done", async () => {
    clock = T0 + 1_000;
    const ids = [await upload("a"), await upload("b"), await upload("c")];
    expect(getGradingBatchStartedAt(assignment.id)).toBe(T0 + 1_000);

    // Nothing measured on this server yet: 60 s per paper; ten at once, so one round.
    expect(getBoardView(assignment, "all").progress).toEqual({
      done: 0, total: 3, queued: 3, grading: 0, startedAt: T0 + 1_000, typicalPaperMs: 60_000, etaMs: 60_000, onePass: null,
    });
    expect(getDashboardView(teacher).assignments[0].progress).toEqual({ done: 0, total: 3 });

    // One paper graded in 30 s: the typical time is now this assignment's.
    await createWorker({ grader: slowGrader(30_000), concurrency: 1, pollMs: 1000 }).runOnce();
    expect(getBoardView(assignment, "all").progress).toEqual({
      done: 1, total: 3, queued: 2, grading: 0, startedAt: T0 + 1_000, typicalPaperMs: 30_000, etaMs: 30_000, onePass: null,
    });

    // A paper being graded for 10 s: 20 s left for it, and the queued one runs beside it.
    const id = ids.find((candidate) => getSubmission(candidate)!.status === "queued")!;
    updateSubmission(id, { status: "grading" });
    getDbRun("UPDATE submissions SET grading_started_at = ? WHERE id = ?", clock - 10_000, id);
    expect(getBoardView(assignment, "all").progress).toMatchObject({ done: 1, total: 3, queued: 1, grading: 1, etaMs: 30_000 });
    updateSubmission(id, { status: "queued" });

    // A regrade during the batch joins it; the dashboard follows.
    await drainQueue(slowGrader(30_000));
    expect(getBoardView(assignment, "all").progress).toBeNull();
    expect(getDashboardView(teacher).assignments[0].progress).toBeNull();
    // The worker ended the batch with its last paper.
    expect(getGradingBatchStartedAt(assignment.id)).toBeNull();

    clock += 60_000;
    regradeSubmission(getSubmission(ids[0])!);
    expect(getBoardView(assignment, "all").progress).toMatchObject({ done: 0, total: 1, queued: 1, startedAt: clock, typicalPaperMs: 30_000 });
  });

  it("estimates with the worker's current concurrency", async () => {
    for (const label of ["a", "b", "c", "d"]) await upload(label);
    const worker = createWorker({ grader: rejectingRateLimit(), concurrency: 2, pollMs: 1000 });
    worker.start();
    // The worker slot is what the views read; createWorker alone does not fill it.
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pag.worker")] = worker;
    await vi.waitFor(() => expect(worker.status().effectiveConcurrency).toBe(1));
    await worker.stop();

    // Four papers, one at a time, 60 s each.
    expect(getBoardView(assignment, "all").progress).toMatchObject({ queued: 4, etaMs: 240_000 });
  });

  it("tells the review page the paper's place in the queue, or when its grading started", async () => {
    const first = await upload("a");
    const second = await upload("b");

    expect(getReviewView(getSubmission(first)!, assignment, ORIGIN)).toMatchObject({ queue: { position: 0 }, gradingTiming: null });
    expect(getReviewView(getSubmission(second)!, assignment, ORIGIN)).toMatchObject({ queue: { position: 1 }, gradingTiming: null });

    clock += 5_000;
    updateSubmission(first, { status: "grading" });
    getDbRun("UPDATE submissions SET grading_started_at = ? WHERE id = ?", clock, first);
    getDbRun("UPDATE jobs SET status = 'running' WHERE target_id = ?", first);
    expect(getReviewView(getSubmission(first)!, assignment, ORIGIN)).toMatchObject({
      queue: null, gradingTiming: { gradingStartedAt: clock, typicalPaperMs: 60_000 },
    });
    expect(getReviewView(getSubmission(second)!, assignment, ORIGIN).queue).toEqual({ position: 0 });

    const graded = await gradedPaper("Maria Lopez");
    expect(getReviewView(graded, assignment, ORIGIN)).toMatchObject({ queue: null, gradingTiming: null });
  });

  it("tells the key tab when the key's reading started and how long readings take", async () => {
    expect(getKeyEditorView(assignment).extraction).toBeNull();
    const draft = seedAssignment(teacher.id);
    clock += 1_000;
    await ingestKeyPdf(draft, { filename: "key.pdf", bytes: await makePdf(2, { label: "key" }) });

    expect(getKeyEditorView(draft).extraction).toEqual({ extractionStartedAt: clock, typicalExtractionMs: 45_000 });

    // A reading that took 20 s becomes the typical time.
    updateKey(assignment.id, { processingStartedAt: T0, processingFinishedAt: T0 + 20_000 });
    expect(getKeyEditorView(draft).extraction).toEqual({ extractionStartedAt: clock, typicalExtractionMs: 20_000 });
  });

  it("shows a scan's split progress while the AI reads it, and whether its papers were graded automatically", async () => {
    const scan = await seedScan(assignment.id, { pages: 30 });
    clock += 12_000;
    updateScan(scan.id, { pagesRead: 20 });

    // 30 pages × 2 s, 12 s gone.
    expect(getScanReviewView(getScan(scan.id)!, assignment)).toMatchObject({
      splitProgress: { splitStartedAt: T0, pagesRead: 20, pageCount: 30, etaMs: 48_000 },
      scan: { autoGraded: false, splitStartedAt: T0, splitFinishedAt: null },
    });

    updateScan(scan.id, { status: "done", splitFinishedAt: T0 + 30_000, autoGraded: true, createdCount: 10 });
    const done = getScanReviewView(getScan(scan.id)!, assignment);
    expect(done).toMatchObject({ splitProgress: null, scan: { autoGraded: true, splitFinishedAt: T0 + 30_000 } });
    expect(getUploadPageView(assignment).scans).toMatchObject([{ id: scan.id, autoGraded: true, createdCount: 10 }]);

    // That split (1 s per page) is now the typical speed.
    const next = await seedScan(assignment.id, { pages: 10 });
    expect(getScanReviewView(next, assignment).splitProgress).toEqual({
      splitStartedAt: clock, pagesRead: 0, pageCount: 10, etaMs: 10_000, papersGraded: null,
    });
  });
});

function getDbRun(sql: string, ...params: unknown[]): void {
  getDb().prepare(sql).run(...params);
}

function rejectingRateLimit() {
  return scriptedGrader({ gradeSubmission: () => Promise.reject(new AiError("rate_limited", "429", { retryable: true, retryAfterMs: 60_000 })) });
}
