import { beforeEach, describe, expect, it } from "vitest";
import { guidanceFingerprint, renderGuidance } from "@/lib/ai/prompts";
import { setClockForTests } from "@/lib/clock";
import { setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeSubmission } from "@/lib/grading/test-utils";
import { isGuidanceStale, loadGuidance } from "@/lib/services/guidance";
import type { Assignment, KeyItem, Submission } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedLesson, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

let clock = 1_700_000_000_000;
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  setClockForTests(() => clock);
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  items = seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2" }]);
});

function lessonOn(item: KeyItem, o: Partial<Parameters<typeof seedLesson>[0]> = {}) {
  clock += 1000;
  return seedLesson({ assignmentId: assignment.id, submissionId: seedSubmission(assignment.id).id, itemId: item.id, ...o });
}

describe("loadGuidance", () => {
  it("is empty, with an empty fingerprint, without preferences or lessons", () => {
    expect(loadGuidance(assignment)).toEqual({ guidance: { preferences: "", lessons: [] }, fingerprint: "", sentIds: [], notSent: {} });
  });

  it("sends the teacher's preferences and the selected lessons, newest first, cut to the guidance limits", () => {
    setGradingPreferences(assignment.teacherId, "Ignore spelling.");
    const older = lessonOn(items[1], { studentAnswer: "co2", reason: "Lowercase is fine." });
    const newer = lessonOn(items[0], { studentAnswer: "x".repeat(500), reason: "" });
    const off = lessonOn(items[0], { active: false, reason: "Not this one." });

    const g = loadGuidance(assignment);

    expect(g.sentIds).toEqual([newer.id, older.id]);
    expect(g.notSent).toEqual({ [off.id]: "inactive" });
    expect(g.guidance.preferences).toBe("Ignore spelling.");
    expect(g.guidance.lessons.map((l) => [l.itemId, l.reason])).toEqual([[items[0].id, ""], [items[1].id, "Lowercase is fine."]]);
    expect(g.guidance.lessons[0].studentAnswer.length).toBeLessThanOrEqual(400);
    expect(g.fingerprint).toBe(guidanceFingerprint(renderGuidance(g.guidance, items)));
    expect(g.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats lessons about items not in the given list as unknown", () => {
    const lesson = lessonOn(items[1]);
    const g = loadGuidance(assignment, [items[0]]);
    expect(g).toMatchObject({ sentIds: [], notSent: { [lesson.id]: "unknown_item" }, fingerprint: "" });
  });

  it("changes its fingerprint when the preferences or a lesson change, and only then", () => {
    const first = loadGuidance(assignment).fingerprint;
    setGradingPreferences(assignment.teacherId, "Be kind.");
    const withPreferences = loadGuidance(assignment).fingerprint;
    expect(withPreferences).not.toBe(first);
    expect(loadGuidance(assignment).fingerprint).toBe(withPreferences);
    lessonOn(items[0], { reason: "Units matter." });
    expect(loadGuidance(assignment).fingerprint).not.toBe(withPreferences);
  });
});

describe("isGuidanceStale", () => {
  const graded = (o: Partial<Submission> = {}) =>
    makeSubmission({ status: "graded", reviewedAt: null, gradedKeyRevision: 2, gradedGuidanceFp: "abc", ...o });

  it("is true for an unreviewed paper graded against the current key with other guidance", () => {
    expect(isGuidanceStale(graded(), 2, "def")).toBe(true);
    expect(isGuidanceStale(graded({ status: "needs_review" }), 2, "def")).toBe(true);
  });

  it("counts a paper graded before guidance existed as graded without guidance", () => {
    expect(isGuidanceStale(graded({ gradedGuidanceFp: null }), 2, "")).toBe(false);
    expect(isGuidanceStale(graded({ gradedGuidanceFp: null }), 2, "def")).toBe(true);
  });

  it("is false for the same guidance, a reviewed paper, a key-stale paper and a paper not graded", () => {
    expect(isGuidanceStale(graded(), 2, "abc")).toBe(false);
    expect(isGuidanceStale(graded({ reviewedAt: 1 }), 2, "def")).toBe(false);
    expect(isGuidanceStale(graded({ gradedKeyRevision: 1 }), 2, "def")).toBe(false);
    for (const status of ["queued", "grading", "failed"] as const) expect(isGuidanceStale(graded({ status }), 2, "def")).toBe(false);
  });
});
