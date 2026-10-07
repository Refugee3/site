import { beforeEach, describe, expect, it } from "vitest";
import type { GradingOutput } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { getLesson, listLessons } from "@/lib/db/repos/lessons";
import { getSubmission, listItems } from "@/lib/db/repos/submissions";
import { getGradingPreferences, setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { sha256Hex } from "@/lib/ids";
import { answeringGrader, drainQueue } from "@/lib/jobs/test-utils";
import { loadGuidance } from "@/lib/services/guidance";
import { addLessonToPreferences, deleteLesson, setLessonActive, updateLessonReason } from "@/lib/services/lessons";
import { gradeManually, regradeSubmission, saveItemOverride, storeTeacherPaper } from "@/lib/services/submissions";
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

/** A paper the teacher uploaded, graded with `item` as the AI's reading of every item. */
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

  it("is not sent when the AI never read the answer (a paper graded by hand)", () => {
    const paper = seedSubmission(assignment.id, { status: "failed", source: "teacher" });
    gradeManually(paper);

    saveItemOverride(getSubmission(paper.id)!, items[0].id, { pointsCenti: 100, feedback: "Good.", reason: "Full marks." });

    const lesson = onlyLesson();
    expect(lesson).toMatchObject({ studentAnswer: "", aiAttempt: null, aiCorrectness: null, teacherAttempt: "complete", teacherCorrectness: "correct" });
    expect(loadGuidance(assignment).notSent).toEqual({ [lesson.id]: "no_reading" });
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

  it("turns a lesson off and on, and deletes it without touching the paper's overrides", async () => {
    const paper = await gradedPaper("ana");
    saveItemOverride(paper, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half." });
    const l = onlyLesson();

    expect(setLessonActive(l, false).active).toBe(false);
    expect(loadGuidance(assignment).notSent[l.id]).toBe("inactive");
    expect(setLessonActive(l, true).active).toBe(true);

    deleteLesson(l);
    expect(getLesson(l.id)).toBeNull();
    expect(listItems(paper.id)[0].overrideCenti).toBe(50);
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
