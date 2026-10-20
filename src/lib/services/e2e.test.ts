// The smoke flows, end to end through the services and the real worker with the fake grader:
// signup → assignment with sections → key upload → extraction → save (approve) → the teacher uploads papers →
// board → override, identity, review → CSV; and a scan of the whole stack → split → papers → a correction → regrade.
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGrader } from "@/lib/ai/fake";
import { registerTeacher } from "@/lib/auth/accounts";
import { setClockForTests } from "@/lib/clock";
import { getAssignment } from "@/lib/db/repos/assignments";
import { getScan } from "@/lib/db/repos/scans";
import { getSubmission, listItems, listSubmissions } from "@/lib/db/repos/submissions";
import { createWorker } from "@/lib/jobs/worker";
import { papersFromLayout } from "@/lib/scan-layout";
import { createAssignment } from "@/lib/services/assignments";
import { loadGuidance } from "@/lib/services/guidance";
import { ingestKeyPdf, saveKey } from "@/lib/services/keys";
import { createPapersFromScan, ingestScan } from "@/lib/services/scans";
import { ingestTeacherUpload, markReviewed, regradeWithGuidance, saveItemOverride, updateIdentity } from "@/lib/services/submissions";
import { buildGradesCsv, getBoardView, getKeyEditorView, getLessonsView, getReviewView, getUploadPageView } from "@/lib/services/views";
import type { Assignment, KeyItem, SaveKeyInput } from "@/lib/types";
import { makePdf, TINY_JPEG, useTestDb } from "@/test/helpers";

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

/** Approves the extracted key as it is (acknowledging the AI-proposed item). */
function approveExtractedKey(a: Assignment, items: KeyItem[]): ReturnType<typeof saveKey> {
  return saveKey(a, {
    teacherNotes: "", acknowledgeAiProposed: true,
    items: items.map((i) => ({
      id: i.id, label: i.label, groupLabel: i.groupLabel, prompt: i.prompt, answerType: i.answerType, expectedAnswer: i.expectedAnswer,
      acceptableAnswers: i.acceptableAnswers, gradingCriteria: i.gradingCriteria, pointsCenti: i.pointsCenti, partialCredit: i.partialCredit,
      page: i.page,
    })),
  });
}

describe("end-to-end flow with the fake grader", () => {
  it("runs from signup to CSV export", async () => {
    const teacher = await registerTeacher({ email: "Rivera@Example.org", displayName: "Ms. Rivera", password: "correct horse battery", code: null });
    let a = createAssignment(teacher.id, {
      title: "Unit 4 Quiz", kind: "quiz", instructions: "Show your work.", gradingMode: "completion", accuracyWeight: 50,
      sectionsText: "Period 1 | P1\nPeriod 3", maxSubmissions: 500, writeNotes: true,
    });
    expect(getUploadPageView(a)).toMatchObject({ keyApproved: false });
    await expect(ingestTeacherUpload(a, { filename: "early.pdf", bytes: await makePdf(1, { label: "early" }) }))
      .rejects.toMatchObject({ code: "key_not_ready" });

    // Key upload → extraction → 6 items, one AI-proposed.
    const keyPdf = await makePdf(2, { label: "key" });
    expect((await ingestKeyPdf(a, { filename: "key.pdf", bytes: keyPdf })).status).toBe("processing");
    expect(await drain()).toBe(1);
    const editor = getKeyEditorView(a);
    expect(editor.key.status).toBe("ready");
    expect(editor.items).toHaveLength(6);
    expect(editor.items.filter((i) => i.answerSource === "ai_proposed")).toHaveLength(1);
    expect(editor.keyPdfUrl).toBe(`/api/teacher/assignments/${a.id}/key/pdf`);

    // Save: refused without the acknowledgement, then approves the key.
    const input: SaveKeyInput = {
      teacherNotes: "", acknowledgeAiProposed: false,
      items: editor.items.map((i) => ({
        id: i.id, label: i.label, groupLabel: i.groupLabel, prompt: i.prompt, answerType: i.answerType, expectedAnswer: i.expectedAnswer,
        acceptableAnswers: i.acceptableAnswers, gradingCriteria: i.gradingCriteria, pointsCenti: i.pointsCenti, partialCredit: i.partialCredit, page: i.page,
      })),
    };
    expect(() => saveKey(a, input)).toThrow(expect.objectContaining({ code: "validation" }));
    expect(saveKey(a, { ...input, acknowledgeAiProposed: true })).toEqual({ revision: 1, staleCount: 0 });
    a = reload(a);
    expect(getKeyEditorView(a).items.every((i) => i.answerSource !== "ai_proposed")).toBe(true);
    expect(getUploadPageView(a)).toMatchObject({ keyApproved: true });

    // The teacher uploads the papers: one PDF, then a PDF plus a photo; a second copy of a file is refused.
    tick();
    const first = await ingestTeacherUpload(a, [{ filename: "s1.pdf", bytes: await makePdf(2, { label: "s1" }) }]);
    tick();
    const second = await ingestTeacherUpload(a, [
      { filename: "s2.pdf", bytes: await makePdf(1, { label: "s2" }) },
      { filename: "photo.jpg", bytes: TINY_JPEG },
    ]);
    expect(getSubmission(first.submissionId)).toMatchObject({ status: "queued", source: "teacher", pageCount: 2 });
    expect(getSubmission(second.submissionId)).toMatchObject({ status: "queued", pageCount: 2 });
    await expect(ingestTeacherUpload(a, [{ filename: "copy.pdf", bytes: await makePdf(2, { label: "s1" }) }]))
      .rejects.toMatchObject({ code: "duplicate" });
    await expect(ingestTeacherUpload(a, { filename: "key.pdf", bytes: keyPdf })).rejects.toMatchObject({ code: "is_answer_key" });

    expect(await drain()).toBe(2);
    const s1 = getSubmission(first.submissionId)!;
    const s2 = getSubmission(second.submissionId)!;
    for (const s of [s1, s2]) {
      expect(["graded", "needs_review"]).toContain(s.status);
      expect(s.scoreMaxCenti).toBe(editor.items.reduce((sum, i) => sum + i.pointsCenti, 0));
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
    const period3 = getReviewView(getSubmission(s1.id)!, a).sections.find((s) => s.label === "Period 3")!;
    updateIdentity(getSubmission(s1.id)!, { studentName: "maria lopez", sectionId: period3.id });
    expect(getSubmission(s1.id)).toMatchObject({ studentName: "Maria Lopez", nameSource: "teacher", sectionId: period3.id });
    markReviewed(getSubmission(s1.id)!);
    const reviewed = getSubmission(s1.id)!;
    expect(reviewed.status).toBe("graded");
    const review = getReviewView(reviewed, a);
    expect(review.items[0].score).toMatchObject({ earnedCenti: 50, overridden: true });
    expect(review.items[0].result).toMatchObject({ overrideFeedback: "Check your units." });

    // Uploads keep working whatever status an assignment was left in before the app became teacher-only.
    tick();
    const late = await ingestTeacherUpload(a, { filename: "scan.pdf", bytes: await makePdf(1, { label: "scan" }) });
    expect(await drain()).toBe(1);
    expect(["graded", "needs_review"]).toContain(getSubmission(late.submissionId)!.status);

    // CSV: header, one row per current paper, BOM and CRLF, no student links.
    const { filename, csv } = buildGradesCsv(a);
    expect(filename).toBe("unit-4-quiz-grades.csv");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\r\n").filter(Boolean);
    expect(lines[0]).toMatch(/^"Section","Student name","Status","Points earned","Points possible","Percent"/);
    expect(lines[0]).not.toContain("Receipt");
    const currentRows = getBoardView(a, "all").groups.flatMap((g) => g.rows).length;
    expect(currentRows).toBe(3);
    expect(lines).toHaveLength(1 + currentRows);
    expect(lines.some((l) => l.includes('"Maria Lopez"') && l.includes('"Period 3"'))).toBe(true);
    expect(csv).not.toContain("/r/");
  });

  it("grades one scan of the whole stack, and learns from a correction", async () => {
    const teacher = await registerTeacher({ email: "kim@example.org", displayName: "Mr. Kim", password: "correct horse battery", code: null });
    let a = createAssignment(teacher.id, {
      title: "Photosynthesis", kind: "homework", instructions: "", gradingMode: "completion", accuracyWeight: 50, sectionsText: "", maxSubmissions: 500,
      writeNotes: true,
    });

    // A three-page key, approved as the AI read it.
    await ingestKeyPdf(a, { filename: "key.pdf", bytes: await makePdf(3, { label: "key" }) });
    expect(await drain()).toBe(1);
    expect(approveExtractedKey(a, getKeyEditorView(a).items)).toEqual({ revision: 1, staleCount: 0 });
    a = reload(a);
    expect(getUploadPageView(a)).toMatchObject({ keyApproved: true, keyPageCount: 3 });

    // One 9-page scan → the AI split → 3 papers of 3 pages, checked, then created and graded.
    tick();
    const scan = await ingestScan(a, { filename: "stack.pdf", bytes: await makePdf(9, { label: "class" }) }, { mode: "auto", pagesPerPaper: null });
    expect(await drain()).toBe(1);
    const split = getScan(scan.id)!;
    expect(split.status).toBe("review");
    expect(papersFromLayout(split.layout!)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(await createPapersFromScan(a, split, split.layout!)).toEqual({ created: 3, duplicates: 0 });
    expect(await drain()).toBe(3);
    const papers = listSubmissions(a.id);
    expect(papers.map((p) => [p.source, p.pageCount])).toEqual([["teacher", 3], ["teacher", 3], ["teacher", 3]]);
    for (const p of papers) expect(["graded", "needs_review"]).toContain(p.status);
    expect(getBoardView(a, "all")).toMatchObject({ counts: { total: 3 }, guidanceStaleCount: 0, active: false });

    // The fake's answers repeat across papers: find an item answered "Sample answer for Q…" on two of them.
    const items = getKeyEditorView(a).items;
    const answers = (paperId: string) => new Map(listItems(paperId).map((r) => [r.itemId, r.judgment]));
    const index = items.findIndex((item) =>
      papers.filter((p) => answers(p.id).get(item.id)?.studentAnswer.startsWith("Sample answer for Q")
        && answers(p.id).get(item.id)?.correctness === "correct").length >= 2);
    expect(index).toBeGreaterThanOrEqual(0);
    const item = items[index];
    const [corrected, other] = papers.filter((p) => answers(p.id).get(item.id)?.correctness === "correct"
      && answers(p.id).get(item.id)?.studentAnswer === `Sample answer for Q${index + 1}`);

    // The teacher gives no credit and says why: a lesson the grader is sent from now on.
    saveItemOverride(getSubmission(corrected.id)!, item.id, { pointsCenti: 0, feedback: null, reason: "That's the textbook's sentence, not an answer." });
    const lessons = getLessonsView(a);
    // The two papers the teacher hasn't corrected were graded before it; the corrected one is left alone.
    expect(lessons).toMatchObject({ sentCount: 1, activeCount: 1, guidanceStaleCount: 2 });
    expect(lessons.lessons[0].lesson).toMatchObject({ teacherAttempt: "none", teacherCorrectness: "no_answer" });
    expect(getBoardView(a, "all").guidanceStaleCount).toBe(2);
    const correctedFp = getSubmission(corrected.id)!.gradedGuidanceFp;

    // Regrading with the latest corrections: the other paper's identical answer now follows the ruling.
    expect(regradeWithGuidance(a)).toBe(2);
    expect(await drain()).toBe(2);
    expect(answers(other.id).get(item.id)).toMatchObject({
      attempt: "none", correctness: "no_answer", teacherNote: "Practice grader: followed your ruling on this answer.",
    });
    const { fingerprint } = loadGuidance(a);
    for (const p of papers) expect(getSubmission(p.id)!.gradedGuidanceFp).toBe(p.id === corrected.id ? correctedFp : fingerprint);
    expect(correctedFp).not.toBe(fingerprint);
    expect(getBoardView(a, "all").guidanceStaleCount).toBe(0);
    expect(listItems(corrected.id).find((r) => r.itemId === item.id)!.overrideCenti).toBe(0);
  });
});
