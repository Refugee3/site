import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import type { DB } from "@/lib/db/connection";
import {
  deleteLesson, deleteLessonFor, getLesson, getLessonForTeacher, listLessons, listLessonsForSubmission, updateLesson, upsertLesson,
  type LessonSnapshot,
} from "@/lib/db/repos/lessons";
import { deleteSubmissionRow } from "@/lib/db/repos/submissions";
import { seedApprovedKey, seedAssignment, seedLesson, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";
import type { Assignment, KeyItem, Submission, Teacher } from "@/lib/types";

const T0 = 1_700_000_000_000;

const SNAPSHOT: LessonSnapshot = {
  studentAnswer: "co2",
  aiAttempt: "complete",
  aiCorrectness: "incorrect",
  teacherAttempt: "complete",
  teacherCorrectness: "correct",
  overrideCenti: 100,
  feedback: "Formulas can be lowercase.",
  whatStudentDid: null,
};

let db: DB;
let teacher: Teacher;
let assignment: Assignment;
let items: KeyItem[];
let paper: Submission;

beforeEach(() => {
  setClockForTests(() => T0);
  db = useTestDb();
  teacher = seedTeacher();
  assignment = seedAssignment(teacher.id);
  items = seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2" }]);
  paper = seedSubmission(assignment.id);
});

function upsert(o: Partial<LessonSnapshot> & { reason?: string; itemId?: string; submissionId?: string } = {}) {
  return upsertLesson({ assignmentId: assignment.id, submissionId: paper.id, itemId: items[0].id, ...SNAPSHOT, ...o });
}

describe("upsertLesson", () => {
  it("creates an active lesson with the snapshots and an empty reason", () => {
    const lesson = upsert();

    expect(lesson).toEqual({
      id: expect.any(String), assignmentId: assignment.id, itemId: items[0].id, submissionId: paper.id, ...SNAPSHOT,
      reason: "", active: true, createdAt: T0, updatedAt: T0,
    });
    expect(getLesson(lesson.id)).toEqual(lesson);
  });

  it("refreshes the snapshots of the same paper and item, keeping id, active, created_at and (when not given) the reason", () => {
    const first = upsert({ reason: "Lowercase is fine." });
    updateLesson(first.id, { active: false });
    setClockForTests(() => T0 + 5);

    const second = upsert({ studentAnswer: "CO2", overrideCenti: null, teacherAttempt: "partial", teacherCorrectness: "minor_error" });

    expect(second).toEqual({
      ...first, studentAnswer: "CO2", overrideCenti: null, teacherAttempt: "partial", teacherCorrectness: "minor_error",
      reason: "Lowercase is fine.", active: false, updatedAt: T0 + 5,
    });
    expect(upsert({ reason: "" }).reason).toBe("");
    expect(listLessons(assignment.id)).toHaveLength(1);
  });

  it("keeps one lesson per paper and item", () => {
    const other = seedSubmission(assignment.id);
    upsert();
    upsert({ itemId: items[1].id });
    upsert({ submissionId: other.id });
    upsert();

    expect(listLessons(assignment.id)).toHaveLength(3);
    expect(listLessonsForSubmission(paper.id).map((l) => l.itemId).sort()).toEqual([items[0].id, items[1].id].sort());
  });

  it("stores a lesson for an answer the AI never judged", () => {
    const lesson = upsert({ aiAttempt: null, aiCorrectness: null, teacherAttempt: null, teacherCorrectness: null, studentAnswer: "" });
    expect(lesson).toMatchObject({ aiAttempt: null, aiCorrectness: null, teacherAttempt: null, teacherCorrectness: null });
  });
});

describe("lookups", () => {
  it("getLessonForTeacher scopes by the owning teacher", () => {
    const lesson = upsert();
    expect(getLessonForTeacher(lesson.id, teacher.id)).toEqual({ lesson, assignment });
    expect(getLessonForTeacher(lesson.id, seedTeacher().id)).toBeNull();
    expect(getLessonForTeacher("missing", teacher.id)).toBeNull();
    expect(getLesson("missing")).toBeNull();
  });

  it("lists an assignment's lessons newest first, then by id", () => {
    const a = upsert();
    const b = upsert({ itemId: items[1].id });
    setClockForTests(() => T0 + 1);
    const newest = upsert({ submissionId: seedSubmission(assignment.id).id });
    const otherAssignment = seedAssignment(teacher.id);
    const [otherItem] = seedApprovedKey(otherAssignment.id, [{}]);
    seedLesson({ assignmentId: otherAssignment.id, submissionId: seedSubmission(otherAssignment.id).id, itemId: otherItem.id });

    expect(listLessons(assignment.id).map((l) => l.id)).toEqual([newest.id, ...[a.id, b.id].sort()]);
    expect(listLessonsForSubmission(paper.id).map((l) => l.id)).toEqual([a.id, b.id].sort());
  });
});

describe("updateLesson and deletion", () => {
  it("updates the reason and the active flag and bumps updated_at", () => {
    const lesson = upsert();
    setClockForTests(() => T0 + 7);

    expect(updateLesson(lesson.id, { reason: "Units are optional here." })).toMatchObject({
      reason: "Units are optional here.", active: true, updatedAt: T0 + 7,
    });
    expect(updateLesson(lesson.id, { active: false })).toMatchObject({ reason: "Units are optional here.", active: false });
    expect(updateLesson(lesson.id, { active: true }).active).toBe(true);
    expect(() => updateLesson("missing", { active: false })).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("deletes by id or by paper and item", () => {
    const first = upsert();
    const second = upsert({ itemId: items[1].id });

    expect(deleteLessonFor(paper.id, items[0].id)).toBe(1);
    expect(deleteLessonFor(paper.id, items[0].id)).toBe(0);
    expect(getLesson(first.id)).toBeNull();

    deleteLesson(second.id);
    expect(listLessons(assignment.id)).toEqual([]);
  });

  it("keeps a lesson when its paper is deleted, and deletes it with its key item", () => {
    const kept = upsert();
    const dropped = upsert({ itemId: items[1].id, submissionId: seedSubmission(assignment.id).id });

    deleteSubmissionRow(paper.id);
    db.prepare("DELETE FROM key_items WHERE id = ?").run(items[1].id);

    expect(listLessons(assignment.id)).toEqual([{ ...kept, submissionId: null }]);
    expect(getLesson(dropped.id)).toBeNull();
    expect(getLessonForTeacher(kept.id, teacher.id)?.lesson.submissionId).toBeNull();
  });
});
