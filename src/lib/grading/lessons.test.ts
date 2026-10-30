import { describe, expect, it } from "vitest";
import type { Attempt, Correctness, KeyItem, Lesson } from "@/lib/types";
import { GUIDANCE_LIMITS, intendedJudgment, isInformative, rulingIsExact, selectGuidanceLessons, toGuidanceLesson } from "./lessons";
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

  it("is true for points no judgment gives exactly, even when the nearest judgment is the AI's", () => {
    expect(isInformative({ ...agreeing, exact: false })).toBe(true);
    expect(isInformative({ ...agreeing, exact: true })).toBe(false);
    expect(isInformative({ ...agreeing, exact: null })).toBe(false);
  });
});

describe("rulingIsExact", () => {
  const ruled = (overrideCenti: number | null, teacherAttempt: Attempt, teacherCorrectness: Correctness) =>
    ({ overrideCenti, teacherAttempt, teacherCorrectness });

  it("is null when the teacher kept the AI's points", () => {
    expect(rulingIsExact(ruled(null, "complete", "correct"), makeKeyItem(), accuracy)).toBeNull();
  });

  it("says whether the ruling scores exactly the teacher's points under the current scoring", () => {
    // A 5-point all-or-nothing matching item: 3 of 5 is taught as "correct", which scores 5.
    const matching = makeKeyItem({ pointsCenti: 500, answerType: "matching", partialCredit: false });
    const nearest = intendedJudgment({ targetCenti: 300, item: matching, mode: accuracy, ai: ai("complete", "partially_correct") });
    expect(nearest).toEqual({ attempt: "complete", correctness: "correct", exact: false });
    expect(rulingIsExact(ruled(300, nearest.attempt, nearest.correctness), matching, accuracy)).toBe(false);
    expect(rulingIsExact(ruled(500, "complete", "correct"), matching, accuracy)).toBe(true);
    // Overrides above the item's points are clamped, as intendedJudgment does.
    expect(rulingIsExact(ruled(900, "complete", "correct"), matching, accuracy)).toBe(true);
    // The same ruling read under completion scoring.
    expect(rulingIsExact(ruled(500, "complete", "incorrect"), matching, completion)).toBe(true);
  });
});

/** Key items of 1 point each (partial credit on), one per id. */
function keyItems(ids: string[]): KeyItem[] {
  return ids.map((id, position) => makeKeyItem({ id, position, pointsCenti: 100 }));
}

describe("selectGuidanceLessons", () => {
  const items = keyItems(["item-1", "item-2"]);

  it("gives each left-out lesson its first reason and sends the rest newest first", () => {
    const sent = lesson({ updatedAt: 50 });
    const older = lesson({ updatedAt: 40, itemId: "item-2" });
    const unknown = lesson({ itemId: "deleted-item", active: false });
    const inactive = lesson({ active: false, aiAttempt: null, aiCorrectness: null });
    const unread = lesson({ aiAttempt: null, aiCorrectness: null });
    const agrees = lesson({ teacherCorrectness: "incorrect", overrideCenti: null });
    const result = selectGuidanceLessons([older, unknown, inactive, unread, agrees, sent], items, accuracy);
    expect(result.sentIds).toEqual([sent.id, older.id]);
    expect(result.lessons).toEqual([toGuidanceLesson(sent, true), toGuidanceLesson(older, true)]);
    expect(result.notSent).toEqual({
      [unknown.id]: "unknown_item", [inactive.id]: "inactive", [unread.id]: "no_reading", [agrees.id]: "agrees",
    });
  });

  it("sends at most the newest five per item", () => {
    const first = Array.from({ length: 7 }, (_, i) => lesson({ updatedAt: 100 - i }));
    const other = lesson({ itemId: "item-2", updatedAt: 1 });
    const result = selectGuidanceLessons([...first, other], items, accuracy);
    expect(result.sentIds).toEqual([...first.slice(0, GUIDANCE_LIMITS.perItem).map((l) => l.id), other.id]);
    expect(result.notSent).toEqual({ [first[5].id]: "limit", [first[6].id]: "limit" });
  });

  it("does not count left-out lessons towards the per-item cap", () => {
    const inactive = Array.from({ length: 6 }, (_, i) => lesson({ updatedAt: 100 - i, active: false }));
    const kept = lesson({ updatedAt: 1 });
    expect(selectGuidanceLessons([...inactive, kept], items, accuracy).sentIds).toEqual([kept.id]);
  });

  it("skips a lesson that does not fit the character budget and keeps filling with smaller ones", () => {
    const reason = (n: number) => "r".repeat(n);
    // Each size is its texts plus 120: 3 + 1000 + 120 = 1123 for "co2" and a 1000-character reason.
    const big = Array.from({ length: 10 }, (_, i) => lesson({ itemId: `big-${i}`, reason: reason(1000), updatedAt: 100 - i }));
    const tooBig = lesson({ itemId: "huge", reason: reason(1000), studentAnswer: "a".repeat(400), feedback: "f".repeat(300),
      whatStudentDid: "w".repeat(300), updatedAt: 50 });
    const small = lesson({ itemId: "small", reason: reason(10), updatedAt: 40 });
    const ids = keyItems([...big.map((l) => l.itemId), "huge", "small"]);
    const result = selectGuidanceLessons([small, tooBig, ...big], ids, accuracy);
    // 10 × 1123 = 11230; the 2120-character lesson would pass 12000, the 133-character one still fits.
    expect(result.sentIds).toEqual([...big.map((l) => l.id), small.id]);
    expect(result.notSent).toEqual({ [tooBig.id]: "limit" });
  });

  it("measures truncated texts, so an over-long answer costs only its first 400 characters", () => {
    const longAnswer = Array.from({ length: 10 }, (_, i) => lesson({ itemId: `i${i}`, studentAnswer: "x".repeat(5000), reason: "ok" }));
    // 400 + 2 + 120 = 522 each: all ten fit although the raw answers alone are 50000 characters.
    expect(selectGuidanceLessons(longAnswer, keyItems(longAnswer.map((l) => l.itemId)), accuracy).sentIds).toHaveLength(10);
  });

  it("is deterministic whatever the input order, breaking time ties by id", () => {
    const lessons = [
      lesson({ id: "b", updatedAt: 10 }), lesson({ id: "a", updatedAt: 10 }), lesson({ id: "c", updatedAt: 20, itemId: "item-2" }),
      lesson({ id: "d", updatedAt: 5, active: false }),
    ];
    const expected = selectGuidanceLessons(lessons, items, accuracy);
    expect(expected.sentIds).toEqual(["c", "a", "b"]);
    for (const shuffled of [[...lessons].reverse(), [lessons[2], lessons[0], lessons[3], lessons[1]]]) {
      expect(selectGuidanceLessons(shuffled, items, accuracy)).toEqual(expected);
    }
  });

  it("does not send a correction of an answer the AI could not read, unless the teacher says why", () => {
    // The AI saw a blank (the answer was on the back), wrote "[illegible]", or could not judge: a full-credit
    // override is about work the grader never saw, and must not teach it that a blank answer is correct.
    const blank = lesson({ studentAnswer: "", aiAttempt: "none", aiCorrectness: "no_answer" });
    const illegible = lesson({ studentAnswer: "x = [illegible]", aiAttempt: "complete", aiCorrectness: "incorrect" });
    const unjudged = lesson({ studentAnswer: "x = 4?", aiAttempt: "complete", aiCorrectness: "cannot_judge" });
    const explained = lesson({ studentAnswer: "", aiAttempt: "none", aiCorrectness: "no_answer", reason: "The answer was on the back." });
    // The teacher agreeing the item is blank is a ruling about blank answers, not a reading fix.
    const ruledBlank = lesson({
      studentAnswer: "", aiAttempt: "partial", aiCorrectness: "incorrect", teacherAttempt: "none", teacherCorrectness: "no_answer",
      overrideCenti: 0,
    });
    const result = selectGuidanceLessons([blank, illegible, unjudged, explained, ruledBlank], items, accuracy);
    expect(result.notSent).toEqual({ [blank.id]: "reading_fix", [illegible.id]: "reading_fix", [unjudged.id]: "reading_fix" });
    expect(new Set(result.sentIds)).toEqual(new Set([explained.id, ruledBlank.id]));
  });

  it("sends a correction whose points no judgment gives, even when the nearest judgment is the AI's", () => {
    // Half credit on a one-point multiple-choice item: complete (1) and none (0) tie, and the tie goes to the AI's pair.
    const mc = makeKeyItem({ id: "mc", pointsCenti: 100, answerType: "multiple_choice", partialCredit: false });
    const half = lesson({ itemId: "mc", aiCorrectness: "incorrect", teacherCorrectness: "incorrect", overrideCenti: 50 });
    // The same judgment with the AI's own points teaches nothing.
    const same = lesson({ itemId: "mc", aiCorrectness: "incorrect", teacherCorrectness: "incorrect", overrideCenti: 0 });
    const result = selectGuidanceLessons([half, same], [mc], accuracy);
    expect(result.sentIds).toEqual([half.id]);
    expect(result.notSent).toEqual({ [same.id]: "agrees" });
    expect(result.lessons[0]).toMatchObject({ overrideCenti: 50, exact: false });
  });

  it("counts the extra lines of an inexact ruling against the character budget", () => {
    // 3 + 1000 + 120 = 1123 for an exact lesson; an inexact one adds 180 more.
    const exact = Array.from({ length: 9 }, (_, i) => lesson({ itemId: `e${i}`, reason: "r".repeat(1000), updatedAt: 100 - i }));
    const inexact = lesson({ itemId: "x", reason: "r".repeat(1000), overrideCenti: 90, updatedAt: 50 });
    const ids = keyItems([...exact.map((l) => l.itemId), "x"]);
    // 9 × 1123 + 1303 = 11410 fits; a 623-character lesson then would not (12033), though it would without the 180 (11853).
    const extra = lesson({ itemId: "y", reason: "r".repeat(500), updatedAt: 40 });
    const result = selectGuidanceLessons([...exact, inexact, extra], [...ids, ...keyItems(["y"])], accuracy);
    expect(result.sentIds).toEqual([...exact.map((l) => l.id), inexact.id]);
    expect(result.notSent).toEqual({ [extra.id]: "limit" });
  });
});

describe("toGuidanceLesson", () => {
  it("keeps the judgments and trims and truncates every text to its limit", () => {
    const l = lesson({
      studentAnswer: `  ${"a".repeat(500)}`, reason: ` ${"r".repeat(1200)} `, feedback: `${"f".repeat(301)}`,
      whatStudentDid: "  You drew it.  ",
    });
    const g = toGuidanceLesson(l, true);
    expect(g).toEqual({
      itemId: l.itemId, aiAttempt: "complete", aiCorrectness: "incorrect", teacherAttempt: "complete", teacherCorrectness: "correct",
      overrideCenti: 100, exact: true,
      studentAnswer: "a".repeat(400), reason: "r".repeat(1000), feedback: "f".repeat(300), whatStudentDid: "You drew it.",
    });
    expect(toGuidanceLesson(lesson({ overrideCenti: null }), false).exact).toBeNull();
    expect(g).not.toHaveProperty("id");
    expect(g).not.toHaveProperty("submissionId");
  });

  it("keeps null notes null and never splits a surrogate pair", () => {
    const g = toGuidanceLesson(lesson({ feedback: null, whatStudentDid: null, studentAnswer: "😀".repeat(401) }), null);
    expect(g.feedback).toBeNull();
    expect(g.whatStudentDid).toBeNull();
    expect(g.studentAnswer).toBe("😀".repeat(400));
  });
});
