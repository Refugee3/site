import { describe, expect, it } from "vitest";
import type { Attempt, Correctness, Lesson } from "@/lib/types";
import { GUIDANCE_LIMITS, intendedJudgment, isInformative, selectGuidanceLessons, toGuidanceLesson } from "./lessons";
import { makeKeyItem } from "./test-utils";

const completion = { gradingMode: "completion", accuracyWeight: 50 } as const;
const accuracy = { gradingMode: "accuracy", accuracyWeight: 50 } as const;
const ai = (attempt: Attempt, correctness: Correctness) => ({ attempt, correctness });

describe("intendedJudgment", () => {
  it("(1) completion: half the points is a partial attempt, keeping the AI's correctness", () => {
    const item = makeKeyItem({ pointsCenti: 200 });
    expect(intendedJudgment({ targetCenti: 100, item, mode: completion, ai: ai("complete", "incorrect") }))
      .toEqual({ attempt: "partial", correctness: "incorrect", exact: true });
  });

  it("(2) accuracy: full points is a complete, correct answer", () => {
    const item = makeKeyItem({ pointsCenti: 100 });
    expect(intendedJudgment({ targetCenti: 100, item, mode: accuracy, ai: ai("complete", "incorrect") }))
      .toEqual({ attempt: "complete", correctness: "correct", exact: true });
  });

  it("(3) accuracy with partial credit: 70 of 100 is nearest a minor error, not exact", () => {
    const item = makeKeyItem({ pointsCenti: 100, partialCredit: true });
    expect(intendedJudgment({ targetCenti: 70, item, mode: accuracy, ai: ai("complete", "correct") }))
      .toEqual({ attempt: "complete", correctness: "minor_error", exact: false });
  });

  it("(4) accuracy, multiple choice: full points is complete and correct", () => {
    const item = makeKeyItem({ pointsCenti: 100, answerType: "multiple_choice", partialCredit: false });
    expect(intendedJudgment({ targetCenti: 100, item, mode: accuracy, ai: ai("complete", "incorrect") }))
      .toEqual({ attempt: "complete", correctness: "correct", exact: true });
  });

  it("(5) blended 40: full points is complete and correct", () => {
    const item = makeKeyItem({ pointsCenti: 200 });
    expect(intendedJudgment({
      targetCenti: 200, item, mode: { gradingMode: "blended", accuracyWeight: 40 }, ai: ai("complete", "partially_correct"),
    })).toEqual({ attempt: "complete", correctness: "correct", exact: true });
  });

  it("(6) completion: zero points is no answer", () => {
    const item = makeKeyItem({ pointsCenti: 100 });
    expect(intendedJudgment({ targetCenti: 0, item, mode: completion, ai: ai("complete", "correct") }))
      .toEqual({ attempt: "none", correctness: "no_answer", exact: true });
  });

  it("(7) without an AI judgment, ties go to the earlier correctness, then the fuller attempt", () => {
    const withPartial = makeKeyItem({ pointsCenti: 100, partialCredit: true });
    expect(intendedJudgment({ targetCenti: 50, item: withPartial, mode: accuracy, ai: null }))
      .toEqual({ attempt: "complete", correctness: "partially_correct", exact: true });
    // All-or-nothing: 0 and 100 are equally far from 50, and "correct" comes first.
    const allOrNothing = makeKeyItem({ pointsCenti: 100, partialCredit: false });
    expect(intendedJudgment({ targetCenti: 50, item: allOrNothing, mode: accuracy, ai: null }))
      .toEqual({ attempt: "complete", correctness: "correct", exact: false });
  });

  it("(8) the AI's own pair wins a tie on points", () => {
    const item = makeKeyItem({ pointsCenti: 100, partialCredit: false });
    expect(intendedJudgment({ targetCenti: 40, item, mode: accuracy, ai: ai("complete", "minor_error") }))
      .toEqual({ attempt: "complete", correctness: "minor_error", exact: false });
  });

  it("keeps multiple-choice and true/false items to binary judgments", () => {
    for (const answerType of ["multiple_choice", "true_false"] as const) {
      const item = makeKeyItem({ pointsCenti: 100, answerType, partialCredit: true });
      for (let target = 0; target <= 100; target += 10) {
        const { attempt, correctness } = intendedJudgment({ targetCenti: target, item, mode: completion, ai: ai("partial", "major_error") });
        expect([["complete", "correct"], ["complete", "incorrect"], ["none", "no_answer"]]).toContainEqual([attempt, correctness]);
      }
    }
    // In completion mode a half-credit target cannot be met by a binary item: complete (100) and none (0) tie.
    const item = makeKeyItem({ pointsCenti: 100, answerType: "true_false" });
    expect(intendedJudgment({ targetCenti: 50, item, mode: completion, ai: ai("complete", "incorrect") }))
      .toEqual({ attempt: "complete", correctness: "incorrect", exact: false });
  });

  it("never proposes cannot_judge", () => {
    const item = makeKeyItem({ pointsCenti: 100 });
    expect(intendedJudgment({ targetCenti: 0, item, mode: accuracy, ai: ai("complete", "cannot_judge") }))
      .toEqual({ attempt: "complete", correctness: "incorrect", exact: true });
  });

  it("clamps the target to the item's points", () => {
    const item = makeKeyItem({ pointsCenti: 100 });
    expect(intendedJudgment({ targetCenti: 500, item, mode: accuracy, ai: null }))
      .toEqual({ attempt: "complete", correctness: "correct", exact: true });
    expect(intendedJudgment({ targetCenti: -20, item, mode: completion, ai: null }))
      .toEqual({ attempt: "none", correctness: "no_answer", exact: true });
  });
});

let nextId = 0;
function lesson(o: Partial<Lesson> = {}): Lesson {
  nextId++;
  return {
    id: `lesson-${String(nextId).padStart(3, "0")}`,
    assignmentId: "assignment-1",
    itemId: "item-1",
    submissionId: "submission-1",
    studentAnswer: "co2",
    aiAttempt: "complete",
    aiCorrectness: "incorrect",
    teacherAttempt: "complete",
    teacherCorrectness: "correct",
    overrideCenti: 100,
    feedback: null,
    whatStudentDid: null,
    reason: "",
    active: true,
    createdAt: 1_000,
    updatedAt: 1_000 + nextId,
    ...o,
  };
}

describe("isInformative", () => {
  const agreeing = { reason: "", aiAttempt: "complete", aiCorrectness: "correct", teacherAttempt: "complete",
    teacherCorrectness: "correct", feedback: null, whatStudentDid: null } as const;

  it("is false when the teacher agreed and said nothing", () => {
    expect(isInformative(agreeing)).toBe(false);
    expect(isInformative({ ...agreeing, reason: "  ", feedback: "", whatStudentDid: " " })).toBe(false);
  });

  it("is true for a reason, a different ruling, or the teacher's wording", () => {
    expect(isInformative({ ...agreeing, reason: "Units are optional here." })).toBe(true);
    expect(isInformative({ ...agreeing, teacherCorrectness: "minor_error" })).toBe(true);
    expect(isInformative({ ...agreeing, teacherAttempt: "partial" })).toBe(true);
    expect(isInformative({ ...agreeing, feedback: "Good use of units." })).toBe(true);
    expect(isInformative({ ...agreeing, whatStudentDid: "You drew the cell." })).toBe(true);
  });

  it("is false when the AI never read the answer", () => {
    expect(isInformative({ ...agreeing, aiAttempt: null, aiCorrectness: null, reason: "Read it again." })).toBe(false);
  });
});

describe("selectGuidanceLessons", () => {
  const items = new Set(["item-1", "item-2"]);

  it("gives each left-out lesson its first reason and sends the rest newest first", () => {
    const sent = lesson({ updatedAt: 50 });
    const older = lesson({ updatedAt: 40, itemId: "item-2" });
    const unknown = lesson({ itemId: "deleted-item", active: false });
    const inactive = lesson({ active: false, aiAttempt: null, aiCorrectness: null });
    const unread = lesson({ aiAttempt: null, aiCorrectness: null });
    const agrees = lesson({ teacherCorrectness: "incorrect" });
    const result = selectGuidanceLessons([older, unknown, inactive, unread, agrees, sent], items);
    expect(result.sentIds).toEqual([sent.id, older.id]);
    expect(result.notSent).toEqual({
      [unknown.id]: "unknown_item", [inactive.id]: "inactive", [unread.id]: "no_reading", [agrees.id]: "agrees",
    });
  });

  it("sends at most the newest five per item", () => {
    const first = Array.from({ length: 7 }, (_, i) => lesson({ updatedAt: 100 - i }));
    const other = lesson({ itemId: "item-2", updatedAt: 1 });
    const result = selectGuidanceLessons([...first, other], items);
    expect(result.sentIds).toEqual([...first.slice(0, GUIDANCE_LIMITS.perItem).map((l) => l.id), other.id]);
    expect(result.notSent).toEqual({ [first[5].id]: "limit", [first[6].id]: "limit" });
  });

  it("does not count left-out lessons towards the per-item cap", () => {
    const inactive = Array.from({ length: 6 }, (_, i) => lesson({ updatedAt: 100 - i, active: false }));
    const kept = lesson({ updatedAt: 1 });
    expect(selectGuidanceLessons([...inactive, kept], items).sentIds).toEqual([kept.id]);
  });

  it("skips a lesson that does not fit the character budget and keeps filling with smaller ones", () => {
    const reason = (n: number) => "r".repeat(n);
    // Each size is its texts plus 120: 3 + 1000 + 120 = 1123 for "co2" and a 1000-character reason.
    const big = Array.from({ length: 10 }, (_, i) => lesson({ itemId: `big-${i}`, reason: reason(1000), updatedAt: 100 - i }));
    const tooBig = lesson({ itemId: "huge", reason: reason(1000), studentAnswer: "a".repeat(400), feedback: "f".repeat(300),
      whatStudentDid: "w".repeat(300), updatedAt: 50 });
    const small = lesson({ itemId: "small", reason: reason(10), updatedAt: 40 });
    const ids = new Set([...big.map((l) => l.itemId), "huge", "small"]);
    const result = selectGuidanceLessons([small, tooBig, ...big], ids);
    // 10 × 1123 = 11230; the 2120-character lesson would pass 12000, the 133-character one still fits.
    expect(result.sentIds).toEqual([...big.map((l) => l.id), small.id]);
    expect(result.notSent).toEqual({ [tooBig.id]: "limit" });
  });

  it("measures truncated texts, so an over-long answer costs only its first 400 characters", () => {
    const longAnswer = Array.from({ length: 10 }, (_, i) => lesson({ itemId: `i${i}`, studentAnswer: "x".repeat(5000), reason: "ok" }));
    // 400 + 2 + 120 = 522 each: all ten fit although the raw answers alone are 50000 characters.
    expect(selectGuidanceLessons(longAnswer, new Set(longAnswer.map((l) => l.itemId))).sentIds).toHaveLength(10);
  });

  it("is deterministic whatever the input order, breaking time ties by id", () => {
    const lessons = [
      lesson({ id: "b", updatedAt: 10 }), lesson({ id: "a", updatedAt: 10 }), lesson({ id: "c", updatedAt: 20, itemId: "item-2" }),
      lesson({ id: "d", updatedAt: 5, active: false }),
    ];
    const expected = selectGuidanceLessons(lessons, items);
    expect(expected.sentIds).toEqual(["c", "a", "b"]);
    for (const shuffled of [[...lessons].reverse(), [lessons[2], lessons[0], lessons[3], lessons[1]]]) {
      expect(selectGuidanceLessons(shuffled, items)).toEqual(expected);
    }
  });
});

describe("toGuidanceLesson", () => {
  it("keeps the judgments and trims and truncates every text to its limit", () => {
    const l = lesson({
      studentAnswer: `  ${"a".repeat(500)}`, reason: ` ${"r".repeat(1200)} `, feedback: `${"f".repeat(301)}`,
      whatStudentDid: "  You drew it.  ",
    });
    const g = toGuidanceLesson(l);
    expect(g).toEqual({
      itemId: l.itemId, aiAttempt: "complete", aiCorrectness: "incorrect", teacherAttempt: "complete", teacherCorrectness: "correct",
      studentAnswer: "a".repeat(400), reason: "r".repeat(1000), feedback: "f".repeat(300), whatStudentDid: "You drew it.",
    });
    expect(g).not.toHaveProperty("id");
    expect(g).not.toHaveProperty("submissionId");
  });

  it("keeps null notes null and never splits a surrogate pair", () => {
    const g = toGuidanceLesson(lesson({ feedback: null, whatStudentDid: null, studentAnswer: "😀".repeat(401) }));
    expect(g.feedback).toBeNull();
    expect(g.whatStudentDid).toBeNull();
    expect(g.studentAnswer).toBe("😀".repeat(400));
  });
});
