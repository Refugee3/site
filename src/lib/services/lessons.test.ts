import { beforeEach, describe, expect, it } from "vitest";
import type { GradingOutput } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import { getLesson, listLessons } from "@/lib/db/repos/lessons";
import { getItem, getSubmission, listItems } from "@/lib/db/repos/submissions";
import { getGradingPreferences, setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { sha256Hex } from "@/lib/ids";
import { answeringGrader, drainQueue } from "@/lib/jobs/test-utils";
import { loadGuidance } from "@/lib/services/guidance";
import { saveKey } from "@/lib/services/keys";
import { addLessonToPreferences, deleteLesson, setLessonActive, updateLessonReason } from "@/lib/services/lessons";
import {
  deleteSubmission, gradeManually, regradeSubmission, regradeWithGuidance, saveItemOverride, storeTeacherPaper, updateIdentity,
} from "@/lib/services/submissions";
import { getBoardView } from "@/lib/services/views";
import type { Assignment, KeyItem, Lesson, Submission, Teacher } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedLesson, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

let clock = 1_700_000_000_000;
let teacher: Teacher;
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  setClockForTests(() => clock);
  useTestDb();
  teacher = seedTeacher();
  assignment = seedAssignment(teacher.id, { gradingMode: "accuracy" });
  items = seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2", pointsCenti: 200 }]);
});

/** A paper the teacher uploaded, graded with `item` as the AI's reading of every item (each read as Maria Lopez's). */
async function gradedPaper(label: string, item: Partial<GradingOutput["items"][number]> = {}): Promise<Submission> {
  const bytes = await makePdf(1, { label });
  const stored = await storeTeacherPaper(assignment, { bytes, pageCount: 1, contentSha256: sha256Hex(bytes) }, `${label}.pdf`);
  await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, { items: refs.map((ref) => makeOutputItem(ref, item)) })));
  return getSubmission(stored!.id)!;
}

function onlyLesson(): Lesson {
  const lessons = listLessons(assignment.id);
  expect(lessons).toHaveLength(1);
  return lessons[0];
}

describe("learning from an override", () => {
  it("records the judgment that the teacher's points stand for, with the AI's reading", async () => {
    const paper = await gradedPaper("ana", { student_answer: "x = 4", attempt: "complete", correctness: "correct" });

    saveItemOverride(paper, items[0].id, { pointsCenti: 70, feedback: null, reason: "  Units are missing.  " });

    expect(onlyLesson()).toMatchObject({
      assignmentId: assignment.id, submissionId: paper.id, itemId: items[0].id, studentAnswer: "x = 4",
      aiAttempt: "complete", aiCorrectness: "correct", teacherAttempt: "complete", teacherCorrectness: "minor_error",
      overrideCenti: 70, feedback: null, whatStudentDid: null, reason: "Units are missing.", active: true,
    });
  });

  it("keeps the AI's judgment for a feedback-only correction", async () => {
    const paper = await gradedPaper("ana", { attempt: "partial", correctness: "major_error" });

    saveItemOverride(paper, items[1].id, { pointsCenti: null, feedback: "Show each step.", whatStudentDid: "You wrote only the answer." });

    expect(onlyLesson()).toMatchObject({
      itemId: items[1].id, aiAttempt: "partial", aiCorrectness: "major_error", teacherAttempt: "partial", teacherCorrectness: "major_error",
      overrideCenti: null, feedback: "Show each step.", whatStudentDid: "You wrote only the answer.", reason: "",
    });
  });

  it("keeps the stored reason when a save leaves it out, and replaces it when one is given", async () => {
    const paper = await gradedPaper("ana");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit." });
    const first = onlyLesson();

    clock += 1000;
    saveItemOverride(paper, items[0].id, { pointsCenti: 60, feedback: null });
    saveItemOverride(paper, items[0].id, { pointsCenti: 60, feedback: null, reason: null });
    expect(onlyLesson()).toMatchObject({ id: first.id, reason: "Half credit.", overrideCenti: 60, createdAt: first.createdAt });
    expect(onlyLesson().updatedAt).toBeGreaterThan(first.updatedAt);

    saveItemOverride(paper, items[0].id, { pointsCenti: 60, feedback: null, reason: "" });
    expect(onlyLesson()).toMatchObject({ id: first.id, reason: "" });
  });

  it("keeps a lesson the teacher turned off turned off when the override changes", async () => {
    const paper = await gradedPaper("ana");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null });
    setLessonActive(onlyLesson(), false);

    saveItemOverride(paper, items[0].id, { pointsCenti: 40, feedback: null });

    expect(onlyLesson()).toMatchObject({ overrideCenti: 40, active: false });
  });

  it("deletes the lesson once all three overrides are cleared, and ignores a reason without an override", async () => {
    const paper = await gradedPaper("ana");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: "Units?", whatStudentDid: "You divided." });
    saveItemOverride(paper, items[0].id, { pointsCenti: null, feedback: null });
    expect(onlyLesson()).toMatchObject({ overrideCenti: null, feedback: null, whatStudentDid: "You divided." });

    saveItemOverride(paper, items[0].id, { pointsCenti: null, feedback: null, whatStudentDid: null, reason: "Why not." });
    expect(listLessons(assignment.id)).toEqual([]);
    saveItemOverride(paper, items[1].id, { pointsCenti: null, feedback: null, reason: "Nothing to learn." });
    expect(listLessons(assignment.id)).toEqual([]);
  });

  it("keeps its snapshots when the paper is regraded", async () => {
    const paper = await gradedPaper("ana", { student_answer: "x = 4" });
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null });
    const before = onlyLesson();

    regradeSubmission(getSubmission(paper.id)!);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
      items: refs.map((ref) => makeOutputItem(ref, { student_answer: "x = 5", correctness: "incorrect" })),
    })));

    expect(onlyLesson()).toEqual(before);
  });

  it("keeps teaching the AI's first mistake when the item is saved again after a regrade that now agrees", async () => {
    const paper = await gradedPaper("ana", { student_answer: "co2", attempt: "complete", correctness: "incorrect" });
    saveItemOverride(paper, items[0].id, { pointsCenti: 100, feedback: null, whatStudentDid: "You wrote the formula in lowercase." });
    const before = onlyLesson();
    expect(loadGuidance(assignment).sentIds).toEqual([before.id]);

    regradeSubmission(getSubmission(paper.id)!);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
      items: refs.map((ref) => makeOutputItem(ref, { student_answer: "CO2", attempt: "complete", correctness: "correct" })),
    })));
    // "Use the AI's note": the points override stays, the note override is cleared.
    clock += 1000;
    saveItemOverride(getSubmission(paper.id)!, items[0].id, { pointsCenti: 100, feedback: null, whatStudentDid: null });

    expect(onlyLesson()).toEqual({
      ...before, studentAnswer: "co2", aiAttempt: "complete", aiCorrectness: "incorrect", teacherAttempt: "complete",
      teacherCorrectness: "correct", whatStudentDid: null, updatedAt: clock,
    });
    expect(loadGuidance(assignment).sentIds).toEqual([before.id]);
  });

  it("keeps no lesson when the AI never read the answer (a paper graded by hand)", () => {
    const paper = seedSubmission(assignment.id, { status: "failed", source: "teacher" });
    gradeManually(paper);

    // The grader could never be sent it, so it would only crowd the Lessons tab.
    saveItemOverride(getSubmission(paper.id)!, items[0].id, { pointsCenti: 100, feedback: "Good.", reason: "Full marks." });
    saveItemOverride(getSubmission(paper.id)!, items[1].id, { pointsCenti: 0, feedback: null });

    expect(getItem(paper.id, items[0].id)).toMatchObject({ overrideCenti: 100, overrideFeedback: "Good." });
    expect(listLessons(assignment.id)).toEqual([]);
    expect(loadGuidance(assignment)).toMatchObject({ sentIds: [], notSent: {} });
  });

  it("drops a stored lesson that has no reading when its question is saved again", () => {
    const paper = seedSubmission(assignment.id, { status: "needs_review", source: "teacher" });
    seedLesson({
      assignmentId: assignment.id, submissionId: paper.id, itemId: items[0].id, studentAnswer: "", aiAttempt: null, aiCorrectness: null,
    });

    saveItemOverride(getSubmission(paper.id)!, items[0].id, { pointsCenti: 50, feedback: null });

    expect(listLessons(assignment.id)).toEqual([]);
  });

  it("does not send a full-credit correction of an answer the AI saw as blank until the teacher says why", async () => {
    // The answer was on the back of the page: the AI read a blank, the teacher gave full credit.
    const paper = await gradedPaper("ana", { student_answer: "", attempt: "none", correctness: "no_answer", legibility: "no_writing" });

    saveItemOverride(paper, items[0].id, { pointsCenti: 100, feedback: null });

    const lesson = onlyLesson();
    expect(lesson).toMatchObject({ studentAnswer: "", aiAttempt: "none", teacherAttempt: "complete", teacherCorrectness: "correct" });
    expect(loadGuidance(assignment)).toMatchObject({ sentIds: [], notSent: { [lesson.id]: "reading_fix" }, fingerprint: "" });

    updateLessonReason(lesson, "The answer is on the back of the page.");
    expect(loadGuidance(assignment).sentIds).toEqual([lesson.id]);
  });

  it("sends points that no judgment gives exactly with the ruling, so later papers go to the teacher", async () => {
    // Item 2 is worth 2 points with partial credit: 1.9 is nearest "correct" (2), which the AI already gave.
    const paper = await gradedPaper("ana", { student_answer: "3 mph", attempt: "complete", correctness: "correct" });

    saveItemOverride(paper, items[1].id, { pointsCenti: 190, feedback: null });

    const lesson = onlyLesson();
    expect(lesson).toMatchObject({ aiCorrectness: "correct", teacherCorrectness: "correct", overrideCenti: 190, reason: "" });
    const g = loadGuidance(assignment);
    expect(g.sentIds).toEqual([lesson.id]);
    expect(g.guidance.lessons).toEqual([expect.objectContaining({ overrideCenti: 190, exact: false })]);
  });

  it("refuses a reason over 1000 characters and saves nothing", async () => {
    const paper = await gradedPaper("ana");
    expect(() => saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "x".repeat(1001) }))
      .toThrow(expect.objectContaining({ code: "validation", extra: { fieldErrors: { reason: ["Use at most 1000 characters."] } } }));
    expect(listItems(paper.id)[0].overrideCenti).toBeNull();
    expect(listLessons(assignment.id)).toEqual([]);
  });
});

describe("managing lessons", () => {
  function lesson(o: Partial<Parameters<typeof seedLesson>[0]> = {}): Lesson {
    return seedLesson({ assignmentId: assignment.id, submissionId: seedSubmission(assignment.id).id, itemId: items[0].id, ...o });
  }

  it("updates the reason, trimmed and at most 1000 characters", () => {
    const l = lesson();
    expect(updateLessonReason(l, "  Units matter.  ").reason).toBe("Units matter.");
    expect(() => updateLessonReason(l, "x".repeat(1001))).toThrow(expect.objectContaining({
      code: "validation", extra: { fieldErrors: { reason: ["Use at most 1000 characters."] } },
    }));
    expect(getLesson(l.id)!.reason).toBe("Units matter.");
  });

  it("turns a lesson off and on, and deletes it once its paper is deleted", async () => {
    const paper = await gradedPaper("ana");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half." });
    const l = onlyLesson();

    expect(setLessonActive(l, false).active).toBe(false);
    expect(loadGuidance(assignment).notSent[l.id]).toBe("inactive");
    expect(setLessonActive(l, true).active).toBe(true);

    await deleteSubmission(getSubmission(paper.id)!);
    expect(deleteLesson(l)).toEqual({ deleted: true });
    expect(getLesson(l.id)).toBeNull();
  });

  it("turns off, rather than deletes, a lesson whose paper still has the correction, so a later save doesn't bring it back", async () => {
    const paper = await gradedPaper("ana", { student_answer: "Photosynthesis makes food.", attempt: "complete", correctness: "correct" });
    saveItemOverride(paper, items[0].id, { pointsCenti: 0, feedback: "Copy.", reason: "0 pts for copying the question" });
    const l = onlyLesson();

    expect(deleteLesson(l)).toEqual({ deleted: false });
    expect(onlyLesson()).toMatchObject({ id: l.id, active: false, reason: "0 pts for copying the question" });
    expect(listItems(paper.id)[0].overrideCenti).toBe(0);

    // A week later: a typo fix in the feedback on that question.
    clock += 1000;
    saveItemOverride(getSubmission(paper.id)!, items[0].id, { pointsCenti: 0, feedback: "Copied." });
    expect(onlyLesson()).toMatchObject({ id: l.id, active: false, feedback: "Copied." });
    expect(loadGuidance(assignment)).toMatchObject({ sentIds: [], notSent: { [l.id]: "inactive" }, fingerprint: "" });
  });
});

describe("guidance staleness", () => {
  const wrongAnswer = (answer: string) => ({ student_answer: answer, attempt: "complete" as const, correctness: "incorrect" as const });

  /**
   * Two papers corrected on item 1 (two lessons on one item), then the paper the teacher did not correct regraded
   * with that guidance (the corrected ones are left alone).
   */
  async function regradedWithTwoLessons(): Promise<void> {
    // A paper of another student (named by the teacher, so regrades keep the name) that the teacher leaves as graded.
    updateIdentity(await gradedPaper("cy", wrongAnswer("x = 5")), { studentName: "Cy Moss", sectionId: null });
    const ana = await gradedPaper("ana", wrongAnswer("x = 4.0"));
    clock += 1000;
    saveItemOverride(ana, items[0].id, { pointsCenti: 100, feedback: null, reason: "Decimals are fine." });
    const ben = await gradedPaper("ben", wrongAnswer("four"));
    clock += 1000;
    saveItemOverride(ben, items[0].id, { pointsCenti: 100, feedback: null, reason: "Number words are fine." });
    clock += 1000;
    expect(regradeWithGuidance(assignment)).toBe(1);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, { items: refs.map((ref) => makeOutputItem(ref, wrongAnswer("5"))) })));
    expect(loadGuidance(assignment).sentIds).toHaveLength(2);
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(0);
  }

  it("is unchanged when a lesson is turned off and on again", async () => {
    await regradedWithTwoLessons();
    const before = loadGuidance(assignment).fingerprint;
    const order = listLessons(assignment.id).map((l) => l.id);
    const older = getLesson(order[1])!;

    clock += 1000;
    expect(setLessonActive(older, false)).toMatchObject({ active: false, updatedAt: older.updatedAt });
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBeGreaterThan(0);
    clock += 1000;
    setLessonActive(getLesson(older.id)!, true);

    expect(loadGuidance(assignment).fingerprint).toBe(before);
    expect(listLessons(assignment.id).map((l) => l.id)).toEqual(order);
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(0);
  });

  it("is unchanged when the key's items are only reordered", async () => {
    const key = (rows: KeyItem[]) => ({
      teacherNotes: "", acknowledgeAiProposed: true,
      items: rows.map((item) => ({
        id: item.id, label: item.label, groupLabel: item.groupLabel, prompt: item.prompt, answerType: item.answerType,
        expectedAnswer: item.expectedAnswer, acceptableAnswers: item.acceptableAnswers, gradingCriteria: item.gradingCriteria,
        pointsCenti: item.pointsCenti, partialCredit: item.partialCredit, page: item.page,
      })),
    });

    // Saved once as it is, so the key has its real fingerprint before papers are graded.
    const { revision } = saveKey(assignment, key(items), { open: false });
    await regradedWithTwoLessons();
    const before = loadGuidance(assignment).fingerprint;

    // Reordering does not change the key's revision: no paper is stale against the key.
    expect(saveKey(assignment, key([...items].reverse()), { open: false })).toEqual({ revision, staleCount: 0 });
    expect(getKey(assignment.id)!.revision).toBe(revision);
    expect(listKeyItems(assignment.id).map((item) => item.id)).toEqual([items[1].id, items[0].id]);
    expect(loadGuidance(assignment).fingerprint).toBe(before);
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBe(0);

    // A change to what the grader is told still counts.
    setGradingPreferences(teacher.id, "Ignore spelling.");
    expect(getBoardView(assignment, "all").guidanceStaleCount).toBeGreaterThan(0);
  });
});

describe("addLessonToPreferences", () => {
  function withReason(reason: string): Lesson {
    return seedLesson({ assignmentId: assignment.id, submissionId: seedSubmission(assignment.id).id, itemId: items[0].id, reason });
  }

  it("appends the reason as a new line", () => {
    expect(addLessonToPreferences(teacher, withReason("Lowercase chemical formulas are fine."))).toEqual({ added: true });
    expect(getGradingPreferences(teacher.id)).toBe("- Lowercase chemical formulas are fine.");

    setGradingPreferences(teacher.id, "Ignore spelling.\n");
    addLessonToPreferences(teacher, withReason("  Units matter\non every answer.  "));
    expect(getGradingPreferences(teacher.id)).toBe("Ignore spelling.\n- Units matter on every answer.");
  });

  it("adds nothing when the line is already there", () => {
    setGradingPreferences(teacher.id, "Ignore spelling.\n  - Units matter.  \nBe kind.");
    expect(addLessonToPreferences(teacher, withReason("Units matter."))).toEqual({ added: false });
    expect(getGradingPreferences(teacher.id)).toBe("Ignore spelling.\n  - Units matter.  \nBe kind.");
    // Case-sensitive: a differently capitalized reason is another line.
    expect(addLessonToPreferences(teacher, withReason("units matter."))).toEqual({ added: true });
  });

  it("needs a reason", () => {
    expect(() => addLessonToPreferences(teacher, withReason("   "))).toThrow(expect.objectContaining({
      code: "validation", message: "Write a reason first.",
    }));
  });

  it("refuses to grow the preferences past 4000 characters", () => {
    const full = "x".repeat(3990);
    setGradingPreferences(teacher.id, full);
    expect(() => addLessonToPreferences(teacher, withReason("Units matter."))).toThrow(expect.objectContaining({
      code: "validation", message: "Your grading preferences are full (4000 characters). Shorten them in Settings first.",
    }));
    expect(getGradingPreferences(teacher.id)).toBe(full);
  });
});
