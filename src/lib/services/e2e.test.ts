// The §11 smoke flow, end to end through the services and the real worker with the fake grader:
// signup → assignment with sections → key upload → extraction → save & open → student uploads →
// receipts → board → override, identity, review → release → released receipt → teacher upload → CSV.
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGrader } from "@/lib/ai/fake";
import { registerTeacher } from "@/lib/auth/accounts";
import { setClockForTests } from "@/lib/clock";
import { getAssignment } from "@/lib/db/repos/assignments";
import { getSubmission, getSubmissionByReceipt } from "@/lib/db/repos/submissions";
import { createWorker } from "@/lib/jobs/worker";
import { createAssignment, setFeedbackReleased, setAssignmentStatus } from "@/lib/services/assignments";
import { ingestKeyPdf, saveKey } from "@/lib/services/keys";
import {
  ingestStudentUpload, ingestTeacherUpload, markReviewed, saveItemOverride, updateIdentity,
} from "@/lib/services/submissions";
import {
  buildGradesCsv, getBoardView, getKeyEditorView, getReceiptView, getReviewView, getStudentUploadView,
} from "@/lib/services/views";
import type { Assignment, SaveKeyInput } from "@/lib/types";
import { makePdf, TINY_JPEG, useTestDb } from "@/test/helpers";

const ORIGIN = "https://grader.school.test";
let clock = 1_700_000_000_000;

beforeEach(() => {
  setClockForTests(() => clock);
  useTestDb();
});

const tick = (ms = 1000) => { clock += ms; };

async function drain(): Promise<number> {
  const worker = createWorker({ grader: createFakeGrader({ delayMs: 0 }), concurrency: 1, pollMs: 1000 });
  let ran = 0;
  while (await worker.runOnce()) ran++;
  return ran;
}

function reload(a: Assignment): Assignment {
  return getAssignment(a.id)!;
}

function tokenOf(receiptUrl: string): string {
  return receiptUrl.slice(receiptUrl.lastIndexOf("/r/") + 3);
}

describe("end-to-end flow with the fake grader", () => {
  it("runs from signup to CSV export", async () => {
    const teacher = await registerTeacher({ email: "Rivera@Example.org", displayName: "Ms. Rivera", password: "correct horse battery", code: null });
    let a = createAssignment(teacher.id, {
      title: "Unit 4 Quiz", instructions: "Show your work.", gradingMode: "completion", accuracyWeight: 50,
      sectionsText: "Period 1 | P1\nPeriod 3", maxSubmissions: 500,
    });
    expect(a.status).toBe("draft");
    expect(getStudentUploadView(a.shareCode)).toMatchObject({ accepting: false, status: "draft", teacherName: "Ms. Rivera" });

    // Key upload → extraction → 6 items, one AI-proposed.
    const keyPdf = await makePdf(2, { label: "key" });
    expect((await ingestKeyPdf(a, { filename: "key.pdf", bytes: keyPdf })).status).toBe("processing");
    expect(await drain()).toBe(1);
    const editor = getKeyEditorView(a);
    expect(editor.key.status).toBe("ready");
    expect(editor.items).toHaveLength(6);
    expect(editor.items.filter((i) => i.answerSource === "ai_proposed")).toHaveLength(1);
    expect(editor.keyPdfUrl).toBe(`/api/teacher/assignments/${a.id}/key/pdf`);

    // Save & open: refused without the acknowledgement, then approves and opens.
    const input: SaveKeyInput = {
      teacherNotes: "", acknowledgeAiProposed: false,
      items: editor.items.map((i) => ({
        id: i.id, label: i.label, groupLabel: i.groupLabel, prompt: i.prompt, answerType: i.answerType, expectedAnswer: i.expectedAnswer,
        acceptableAnswers: i.acceptableAnswers, gradingCriteria: i.gradingCriteria, pointsCenti: i.pointsCenti, partialCredit: i.partialCredit, page: i.page,
      })),
    };
    expect(() => saveKey(a, input, { open: true })).toThrow(expect.objectContaining({ code: "validation" }));
    expect(saveKey(a, { ...input, acknowledgeAiProposed: true }, { open: true })).toEqual({ revision: 1, staleCount: 0 });
    a = reload(a);
    expect(a.status).toBe("open");
    expect(getKeyEditorView(a).items.every((i) => i.answerSource !== "ai_proposed")).toBe(true);

    // Student uploads: one PDF, then a PDF plus a photo.
    tick();
    const first = await ingestStudentUpload(a.shareCode, [{ filename: "s1.pdf", bytes: await makePdf(2, { label: "s1" }) }]);
    tick();
    const second = await ingestStudentUpload(a.shareCode, [
      { filename: "s2.pdf", bytes: await makePdf(1, { label: "s2" }) },
      { filename: "photo.jpg", bytes: TINY_JPEG },
    ]);
    expect(first.duplicate).toBe(false);
    expect(first.receiptUrl).toMatch(/^\/r\/[A-Za-z0-9_-]{43}$/);
    expect(getReceiptView(tokenOf(first.receiptUrl))).toMatchObject({ phase: "processing", pageCount: 2 });
    expect(getReceiptView(tokenOf(second.receiptUrl))).toMatchObject({ phase: "processing", pageCount: 2 });
    // A byte-identical replay returns the same receipt.
    expect(await ingestStudentUpload(a.shareCode, [{ filename: "again.pdf", bytes: await makePdf(2, { label: "s1" }) }]))
      .toEqual({ receiptUrl: first.receiptUrl, duplicate: true });

    expect(await drain()).toBe(2);
    const s1 = getSubmissionByReceipt(tokenOf(first.receiptUrl))!;
    const s2 = getSubmissionByReceipt(tokenOf(second.receiptUrl))!;
    for (const s of [s1, s2]) {
      expect(["graded", "needs_review"]).toContain(s.status);
      expect(s.scoreMaxCenti).toBe(editor.items.reduce((sum, i) => sum + i.pointsCenti, 0));
      const receipt = getReceiptView(s.receiptToken)!;
      expect(receipt.phase).toBe("checked");
      expect(receipt.result).toBeNull();
    }

    // Board: configured sections in order, then "No section".
    const board = getBoardView(a, "all");
    const labels = board.groups.map((g) => g.label);
    const expectedOrder = ["Period 1", "Period 3", "No section"].filter((l) => labels.includes(l));
    expect(labels).toEqual(expectedOrder);
    expect(board.groups.flatMap((g) => g.rows).map((r) => r.submissionId).sort()).toEqual([s1.id, s2.id].sort());

    // Review: override an item, fix the identity, mark reviewed.
    const items = getKeyEditorView(a).items;
    saveItemOverride(s1, items[0].id, { pointsCenti: 50, feedback: "Check your units." });
    const period3 = getReviewView(getSubmission(s1.id)!, a, ORIGIN).sections.find((s) => s.label === "Period 3")!;
    updateIdentity(getSubmission(s1.id)!, { studentName: "maria lopez", sectionId: period3.id });
    expect(getSubmission(s1.id)).toMatchObject({ studentName: "Maria Lopez", nameSource: "teacher", sectionId: period3.id });
    markReviewed(getSubmission(s1.id)!);
    const reviewed = getSubmission(s1.id)!;
    expect(reviewed.status).toBe("graded");
    const review = getReviewView(reviewed, a, ORIGIN);
    expect(review.items[0].score).toMatchObject({ earnedCenti: 50, overridden: true });
    expect(review.receiptUrl).toBe(`${ORIGIN}/r/${reviewed.receiptToken}`);

    // Release: the reviewed paper shows its results; a needs_review paper never does.
    a = setFeedbackReleased(a, true);
    const released = getReceiptView(reviewed.receiptToken)!;
    expect(released.phase).toBe("released");
    expect(released.detectedName).toBe("Maria Lopez");
    expect(released.result!.earnedCenti).toBe(review.score.earnedCenti);
    const releasedItems = released.result!.groups.flatMap((g) => g.items);
    expect(releasedItems).toHaveLength(6);
    expect(releasedItems[0]).toMatchObject({ earnedCenti: 50, feedback: "Check your units." });
    expect(releasedItems.every((i) => i.whatStudentDid.length > 0)).toBe(true);
    expect(released.result!.groups.find((g) => g.groupLabel === "3")?.items.map((i) => i.label)).toEqual(["3a", "3b"]);
    const other = getSubmission(s2.id)!;
    expect(getReceiptView(other.receiptToken)!.phase).toBe(other.status === "graded" ? "released" : "checked");

    // Teacher upload works on a closed assignment and returns an absolute receipt link.
    a = setAssignmentStatus(a, "closed");
    await expect(ingestStudentUpload(a.shareCode, [{ filename: "late.pdf", bytes: await makePdf(1, { label: "late" }) }]))
      .rejects.toMatchObject({ code: "closed" });
    tick();
    const scanned = await ingestTeacherUpload(a, { filename: "scan.pdf", bytes: await makePdf(1, { label: "scan" }) }, ORIGIN);
    expect(scanned.receiptUrl).toMatch(new RegExp(`^${ORIGIN}/r/[A-Za-z0-9_-]{43}$`));
    await expect(ingestTeacherUpload(a, { filename: "key.pdf", bytes: keyPdf }, ORIGIN)).rejects.toMatchObject({ code: "is_answer_key" });
    expect(await drain()).toBe(1);
    expect(["graded", "needs_review"]).toContain(getSubmission(scanned.submissionId)!.status);

    // CSV: header, one row per current paper, BOM and CRLF.
    const { filename, csv } = buildGradesCsv(a, ORIGIN);
    expect(filename).toBe("unit-4-quiz-grades.csv");
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n").filter(Boolean);
    expect(lines[0]).toMatch(/^"Section","Student name","Status","Points earned","Points possible","Percent"/);
    const currentRows = getBoardView(a, "all").groups.flatMap((g) => g.rows).length;
    expect(currentRows).toBe(3);
    expect(lines).toHaveLength(1 + currentRows);
    expect(lines.some((l) => l.includes('"Maria Lopez"') && l.includes(`${ORIGIN}/r/${reviewed.receiptToken}`))).toBe(true);
  });
});
