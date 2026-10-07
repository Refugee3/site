import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import {
  addAssignmentUsage, deleteAssignmentRow, getAssignment, getAssignmentByShareCode, getAssignmentForTeacher, getAssignmentUsage,
  insertAssignment, latestSectionsForTeacher, listAssignmentsForTeacher, listSections, replaceSections, shareCodeExists,
  updateAssignment,
} from "@/lib/db/repos/assignments";
import { getSubmission, updateSubmission } from "@/lib/db/repos/submissions";
import { newId } from "@/lib/ids";
import { seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";
import type { Teacher } from "@/lib/types";

const T0 = 1_700_000_000_000;

let teacher: Teacher;

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  teacher = seedTeacher({ displayName: "Ms. Rivera" });
});

describe("assignments", () => {
  it("inserts a draft with timestamps and reads it back", () => {
    const a = insertAssignment({
      id: newId(), teacherId: teacher.id, title: "Unit 4 Quiz", instructions: "Show work.", gradingMode: "blended",
      accuracyWeight: 40, shareCode: "K7M4QX", maxSubmissions: 30,
    });
    expect(a).toMatchObject({
      status: "draft", gradingMode: "blended", accuracyWeight: 40, feedbackReleasedAt: null, createdAt: T0, updatedAt: T0,
    });
    expect(getAssignment(a.id)).toEqual(a);
    expect(shareCodeExists("K7M4QX")).toBe(true);
    expect(shareCodeExists("K7M4QZ")).toBe(false);
  });

  it("scopes getAssignmentForTeacher by owner", () => {
    const a = seedAssignment(teacher.id);
    expect(getAssignmentForTeacher(a.id, teacher.id)).toEqual(a);
    expect(getAssignmentForTeacher(a.id, seedTeacher().id)).toBeNull();
  });

  it("finds an assignment by share code with the teacher's display name", () => {
    const a = seedAssignment(teacher.id);
    expect(getAssignmentByShareCode(a.shareCode)).toEqual({ ...a, teacherName: "Ms. Rivera" });
    expect(getAssignmentByShareCode("ZZZZZZ")).toBeNull();
  });

  it("lists a teacher's assignments newest first", () => {
    const first = seedAssignment(teacher.id, { title: "First" });
    const second = seedAssignment(teacher.id, { title: "Second, same ms" });
    setClockForTests(() => T0 + 1);
    const third = seedAssignment(teacher.id, { title: "Third" });
    seedAssignment(seedTeacher().id);

    expect(listAssignmentsForTeacher(teacher.id).map((a) => a.id)).toEqual([third.id, second.id, first.id]);
  });

  it("updates only the patched fields and bumps updated_at", () => {
    const a = seedAssignment(teacher.id);
    setClockForTests(() => T0 + 50);

    const updated = updateAssignment(a.id, { status: "open", feedbackReleasedAt: T0 + 50 });

    expect(updated).toEqual({ ...a, status: "open", feedbackReleasedAt: T0 + 50, updatedAt: T0 + 50 });
    expect(updateAssignment(a.id, { feedbackReleasedAt: null }).feedbackReleasedAt).toBeNull();
  });

  it("throws not_found when updating a missing assignment", () => {
    expect(() => updateAssignment("missing", { title: "x" })).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("deletes the row", () => {
    const a = seedAssignment(teacher.id);
    deleteAssignmentRow(a.id);
    expect(getAssignment(a.id)).toBeNull();
  });
});

describe("sections", () => {
  it("replaceSections keeps the ids of surviving canonical keys and applies the new order and labels", () => {
    const a = seedAssignment(teacher.id, {
      sections: [{ label: "Period 1", canonicalKey: "1" }, { label: "Period 2", canonicalKey: "2" }, { label: "Period 3", canonicalKey: "3" }],
    });
    const [p1, p2, p3] = listSections(a.id);
    const inP2 = seedSubmission(a.id);
    updateSubmission(inP2.id, { sectionId: p2.id });

    const next = replaceSections(a.id, [
      { label: "3rd period", aliases: ["P3", "Per 3"], canonicalKey: "3" },
      { label: "Period 1", aliases: [], canonicalKey: "1" },
      { label: "Period 4", aliases: [], canonicalKey: "4" },
    ]);

    expect(next.map((s) => [s.label, s.sortOrder, s.aliases])).toEqual([
      ["3rd period", 0, ["P3", "Per 3"]], ["Period 1", 1, []], ["Period 4", 2, []],
    ]);
    expect(next[0].id).toBe(p3.id);
    expect(next[1].id).toBe(p1.id);
    expect([p1.id, p2.id, p3.id]).not.toContain(next[2].id);
    expect(getSubmission(inP2.id)!.sectionId).toBeNull();
  });

  it("replaceSections with an empty list removes every section", () => {
    const a = seedAssignment(teacher.id, { sections: [{ label: "Period 1", canonicalKey: "1" }] });
    expect(replaceSections(a.id, [])).toEqual([]);
    expect(listSections(a.id)).toEqual([]);
  });

  it("latestSectionsForTeacher returns the sections of the most recent assignment", () => {
    expect(latestSectionsForTeacher(teacher.id)).toEqual([]);
    seedAssignment(teacher.id, { sections: [{ label: "Old", canonicalKey: "old" }] });
    setClockForTests(() => T0 + 1);
    const latest = seedAssignment(teacher.id, { sections: [{ label: "Period 5", aliases: ["P5"], canonicalKey: "5" }] });
    seedAssignment(seedTeacher().id, { sections: [{ label: "Someone else's", canonicalKey: "x" }] });

    expect(latestSectionsForTeacher(teacher.id)).toEqual(listSections(latest.id));
    expect(latestSectionsForTeacher(teacher.id).map((s) => s.aliases)).toEqual([["P5"]]);
  });
});

describe("AI usage ledger", () => {
  const MODEL = "claude-opus-5-5";
  const usage = (n: number) => ({ inputTokens: n, outputTokens: 2 * n, cacheReadTokens: 3 * n, cacheWriteTokens: 4 * n });

  it("adds up direct calls per served model, without agent totals", () => {
    const a = seedAssignment(teacher.id);
    expect(getAssignmentUsage(a.id)).toEqual({});

    addAssignmentUsage(a.id, MODEL, usage(10));
    addAssignmentUsage(a.id, MODEL, usage(1));
    addAssignmentUsage(a.id, "claude-other", usage(5));

    expect(getAssignmentUsage(a.id)).toEqual({
      [MODEL]: { calls: 2, ...usage(11) },
      "claude-other": { calls: 1, ...usage(5) },
    });
  });

  it("also adds hosted-agent sessions to the model's agent totals, with list cost and running time", () => {
    const a = seedAssignment(teacher.id);

    addAssignmentUsage(a.id, MODEL, usage(100), { listCostCents: 42, activeSeconds: 90 });
    addAssignmentUsage(a.id, MODEL, usage(10));
    addAssignmentUsage(a.id, MODEL, usage(200), { listCostCents: null, activeSeconds: 30 });
    addAssignmentUsage(a.id, MODEL, usage(300), { listCostCents: 8, activeSeconds: 0 });

    expect(getAssignmentUsage(a.id)).toEqual({
      [MODEL]: {
        calls: 4, ...usage(610),
        agent: { sessions: 3, ...usage(600), listCostCents: 50, unpricedSessions: 1, activeSeconds: 120 },
      },
    });
  });

  it("keeps agent totals per model", () => {
    const a = seedAssignment(teacher.id);

    addAssignmentUsage(a.id, MODEL, usage(1), { listCostCents: null, activeSeconds: 5 });
    addAssignmentUsage(a.id, "claude-other", usage(2));

    expect(getAssignmentUsage(a.id)).toEqual({
      [MODEL]: {
        calls: 1, ...usage(1), agent: { sessions: 1, ...usage(1), listCostCents: 0, unpricedSessions: 1, activeSeconds: 5 },
      },
      "claude-other": { calls: 1, ...usage(2) },
    });
  });

  it("is a no-op for a deleted assignment", () => {
    const a = seedAssignment(teacher.id);
    deleteAssignmentRow(a.id);

    addAssignmentUsage(a.id, MODEL, usage(1), { listCostCents: 1, activeSeconds: 1 });

    expect(getAssignmentUsage(a.id)).toEqual({});
  });
});
