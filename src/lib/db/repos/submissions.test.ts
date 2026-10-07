import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import type { DB } from "@/lib/db/connection";
import { listSections, replaceSections } from "@/lib/db/repos/assignments";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { upsertKeyItems } from "@/lib/db/repos/keys";
import {
  countByStatus, countSubmissions, deleteSubmissionRow, findBySha, getItem, getSubmission, getSubmissionByReceipt,
  getSubmissionForTeacher, insertSubmission, listGuidanceStaleIds, listIdsByStatus, listItems, listItemsForAssignment, listQueuedWithoutJob,
  listStaleIds, listSubmissions, markFailed, requeueForRegrade, resetGradingToQueued, saveGradingResult, scheduleRetry,
  setItemOverride, startGrading, updateSubmission, type GradingWrite,
} from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { seedApprovedKey, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";
import type { Assignment, ItemJudgment, KeyItem, Section, Submission, Teacher } from "@/lib/types";

const T0 = 1_700_000_000_000;

let db: DB;
let teacher: Teacher;
let assignment: Assignment;
let items: KeyItem[];
let sections: Section[];

beforeEach(() => {
  setClockForTests(() => T0);
  db = useTestDb();
  teacher = seedTeacher();
  assignment = seedAssignment(teacher.id, {
    sections: [{ label: "Period 1", canonicalKey: "1" }, { label: "Period 3", canonicalKey: "3" }],
  });
  sections = listSections(assignment.id);
  items = seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2" }, { label: "3" }]);
});

function judgment(o: Partial<ItemJudgment> = {}): ItemJudgment {
  return {
    attempt: "complete",
    correctness: "correct",
    legibility: "clear",
    confidence: "high",
    reviewReason: "none",
    studentAnswer: "x = 4",
    pages: [1],
    whatStudentDid: "You solved it.",
    feedback: "Nice work.",
    teacherNote: "",
    ...o,
  };
}

function gradingWrite(
  s: Submission,
  o: Partial<Omit<GradingWrite, "fields">> & { fields?: Partial<GradingWrite["fields"]> } = {},
): GradingWrite {
  return {
    submissionId: s.id,
    generation: s.gradingGeneration,
    keyRevision: 1,
    guidanceFingerprint: "",
    items: items.map((item) => ({ itemId: item.id, judgment: judgment() })),
    ...o,
    fields: {
      aiName: "maria lopez",
      aiNameConfidence: "high",
      aiSectionRaw: "Per. 3",
      aiSectionMatch: "Period 3",
      studentName: "Maria Lopez",
      nameSource: "ai",
      nameKey: "lopez maria",
      nameSortKey: "lopez maria",
      sectionId: sections[1].id,
      sectionKey: "3",
      sectionSource: "ai",
      documentMatch: "matches",
      flags: ["fallback_model"],
      status: "graded",
      teacherSummary: "Solid work.",
      integrityNote: "",
      unmatchedWork: "",
      aiModel: "claude-opus-5-5",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      overallFeedback: "Great effort overall.",
      aiOutputJson: "{\"ok\":true}",
      ...o.fields,
    },
  };
}

function gradingSubmission(o: Parameters<typeof seedSubmission>[1] = {}): Submission {
  const s = seedSubmission(assignment.id, o);
  expect(startGrading(s.id, s.gradingGeneration)).toBe(true);
  return getSubmission(s.id)!;
}

describe("insertSubmission", () => {
  it("inserts a queued submission at generation 1", () => {
    const s = seedSubmission(assignment.id, { originalFilename: "quiz.pdf", pageCount: 3 });
    expect(s).toMatchObject({
      assignmentId: assignment.id, status: "queued", gradingGeneration: 1, originalFilename: "quiz.pdf", pageCount: 3,
      flags: [], nameSortKey: "~", overallFeedbackEdited: false, usage: null, gradedGuidanceFp: null, aiEngine: null, createdAt: T0,
      updatedAt: T0,
    });
    expect(getSubmission(s.id)).toEqual(s);
    expect(getSubmissionByReceipt(s.receiptToken)).toEqual(s);
    expect(findBySha(assignment.id, s.contentSha256)).toEqual(s);
  });

  it("throws AppError duplicate for the same content in the same assignment only", () => {
    seedSubmission(assignment.id, { contentSha256: "same" });
    const attempt = () => seedSubmission(assignment.id, { contentSha256: "same" });
    expect(attempt).toThrow(AppError);
    expect(attempt).toThrow(expect.objectContaining({ code: "duplicate" }));

    const other = seedAssignment(teacher.id);
    expect(seedSubmission(other.id, { contentSha256: "same" }).contentSha256).toBe("same");
  });

  it("lets other constraint violations through unchanged", () => {
    const s = seedSubmission(assignment.id);
    expect(() => insertSubmission({ ...s, id: "other", contentSha256: "different" })).toThrow(/receipt_token/);
  });
});

describe("lookups", () => {
  it("getSubmissionForTeacher scopes by the owning teacher", () => {
    const s = seedSubmission(assignment.id);
    expect(getSubmissionForTeacher(s.id, teacher.id)).toEqual({ submission: s, assignment });
    expect(getSubmissionForTeacher(s.id, seedTeacher().id)).toBeNull();
    expect(getSubmissionForTeacher("missing", teacher.id)).toBeNull();
  });

  it("counts and lists submissions", () => {
    const first = seedSubmission(assignment.id);
    setClockForTests(() => T0 + 1);
    const second = seedSubmission(assignment.id, { status: "failed" });
    seedSubmission(seedAssignment(teacher.id).id);

    expect(countSubmissions(assignment.id)).toBe(2);
    expect(listSubmissions(assignment.id).map((s) => s.id)).toEqual([first.id, second.id]);
    expect(countByStatus(assignment.id)).toEqual({ queued: 1, grading: 0, graded: 0, needs_review: 0, failed: 1, total: 2 });
    expect(listIdsByStatus(assignment.id, ["failed", "graded"])).toEqual([second.id]);
    expect(listIdsByStatus(assignment.id, [])).toEqual([]);
  });
});

describe("startGrading", () => {
  it("accepts queued and grading for the current generation", () => {
    const s = seedSubmission(assignment.id);
    expect(startGrading(s.id, 1)).toBe(true);
    expect(getSubmission(s.id)!.status).toBe("grading");
    expect(startGrading(s.id, 1)).toBe(true);
  });

  it("rejects a stale generation and finished statuses", () => {
    const s = seedSubmission(assignment.id);
    expect(startGrading(s.id, 0)).toBe(false);
    requeueForRegrade(s.id);
    expect(startGrading(s.id, 1)).toBe(false);
    expect(getSubmission(s.id)!.status).toBe("queued");

    const graded = seedSubmission(assignment.id, { status: "graded" });
    expect(startGrading(graded.id, graded.gradingGeneration)).toBe(false);
  });
});

describe("saveGradingResult", () => {
  it("writes the result, items, revision and timestamps", () => {
    const s = gradingSubmission();
    setClockForTests(() => T0 + 500);

    expect(saveGradingResult(gradingWrite(s, { keyRevision: 4 }))).toBe(true);

    const saved = getSubmission(s.id)!;
    expect(saved).toMatchObject({
      status: "graded", studentName: "Maria Lopez", nameSource: "ai", sectionId: sections[1].id, sectionSource: "ai",
      flags: ["fallback_model"], overallFeedback: "Great effort overall.", gradedKeyRevision: 4, gradedAt: T0 + 500,
      aiModel: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      teacherSummary: "Solid work.", documentMatch: "matches",
    });
    expect(db.prepare("SELECT ai_output_json FROM submissions WHERE id = ?").get(s.id)).toEqual({ ai_output_json: "{\"ok\":true}" });
    expect(listItems(s.id).map((i) => [i.itemId, i.judgment])).toEqual(items.map((item) => [item.id, judgment()]));
  });

  it("records the fingerprint of the guidance the grading was sent", () => {
    const withGuidance = gradingSubmission();
    const without = gradingSubmission();

    saveGradingResult(gradingWrite(withGuidance, { guidanceFingerprint: "fp-1" }));
    saveGradingResult(gradingWrite(without));

    expect(getSubmission(withGuidance.id)!.gradedGuidanceFp).toBe("fp-1");
    expect(getSubmission(without.id)!.gradedGuidanceFp).toBe("");
  });

  it("records the engine that produced the grading, NULL when the caller doesn't say", () => {
    const byAgent = gradingSubmission();
    const unknown = gradingSubmission();

    saveGradingResult(gradingWrite(byAgent, { fields: { aiEngine: "agent" } }));
    saveGradingResult(gradingWrite(unknown));

    expect(getSubmission(byAgent.id)!.aiEngine).toBe("agent");
    expect(getSubmission(unknown.id)!.aiEngine).toBeNull();
    expect(db.prepare("SELECT ai_engine FROM submissions WHERE id = ?").get(byAgent.id)).toEqual({ ai_engine: "agent" });
    expect(listSubmissions(assignment.id).map((s) => s.aiEngine)).toEqual(["agent", null]);
  });

  it("replaces the engine on a regrade, also with NULL", () => {
    const s = gradingSubmission();
    saveGradingResult(gradingWrite(s, { fields: { aiEngine: "agent" } }));

    saveGradingResult(gradingWrite(s, { fields: { aiEngine: "direct" } }));
    expect(getSubmission(s.id)!.aiEngine).toBe("direct");
    saveGradingResult(gradingWrite(s, { fields: { aiEngine: null } }));
    expect(getSubmission(s.id)!.aiEngine).toBeNull();
  });

  it("keeps the engine of the last grading when the paper is queued again or fails", () => {
    const s = gradingSubmission();
    saveGradingResult(gradingWrite(s, { fields: { aiEngine: "fake" } }));

    const generation = requeueForRegrade(s.id);
    expect(startGrading(s.id, generation)).toBe(true);
    markFailed(s.id, generation, "server_error", "Try again.");

    expect(getSubmission(s.id)!.aiEngine).toBe("fake");
  });

  it("writes nothing when the generation moved on", () => {
    const s = gradingSubmission();
    requeueForRegrade(s.id);

    expect(saveGradingResult(gradingWrite(s))).toBe(false);

    expect(getSubmission(s.id)).toMatchObject({ status: "queued", studentName: null, gradedAt: null });
    expect(listItems(s.id)).toEqual([]);
  });

  it("returns false for a deleted submission", () => {
    const s = gradingSubmission();
    deleteSubmissionRow(s.id);
    expect(saveGradingResult(gradingWrite(s))).toBe(false);
  });

  it("keeps teacher overrides and replaces only the AI columns", () => {
    const s = gradingSubmission();
    setItemOverride(s.id, items[0].id, { overrideCenti: 25, overrideFeedback: "See me." });

    saveGradingResult(gradingWrite(s, {
      items: [{ itemId: items[0].id, judgment: judgment({ correctness: "incorrect" }) }, { itemId: items[1].id, judgment: null }],
    }));

    const [first, second] = listItems(s.id);
    expect(first).toMatchObject({ overrideCenti: 25, overrideFeedback: "See me.", judgment: judgment({ correctness: "incorrect" }) });
    expect(second).toMatchObject({ itemId: items[1].id, judgment: null, overrideCenti: null });
  });

  it("keeps an edited overall feedback and replaces an unedited one", () => {
    const edited = gradingSubmission();
    updateSubmission(edited.id, { overallFeedback: "Teacher's words.", overallFeedbackEdited: true });
    const untouched = gradingSubmission();
    updateSubmission(untouched.id, { overallFeedback: "Old AI words." });

    saveGradingResult(gradingWrite(edited));
    saveGradingResult(gradingWrite(untouched));

    expect(getSubmission(edited.id)!.overallFeedback).toBe("Teacher's words.");
    expect(getSubmission(untouched.id)!.overallFeedback).toBe("Great effort overall.");
  });

  it("skips judgments for items that are no longer in the key", () => {
    const s = gradingSubmission();
    const [kept] = upsertKeyItems(assignment.id, [{ ...items[0] }]);

    expect(saveGradingResult(gradingWrite(s))).toBe(true);

    expect(listItems(s.id).map((i) => i.itemId)).toEqual([kept.id]);
  });

  it("clears status_note, error fields and reviewed_at", () => {
    const s = gradingSubmission();
    db.prepare("UPDATE submissions SET status_note = 'Retrying', error_code = 'x', error_message = 'y', reviewed_at = 5 WHERE id = ?")
      .run(s.id);

    saveGradingResult(gradingWrite(s));

    expect(getSubmission(s.id)).toMatchObject({ statusNote: null, errorCode: null, errorMessage: null, reviewedAt: null });
  });

  it("drops a matched section that was deleted while grading and flags the paper for review", () => {
    const s = gradingSubmission();
    replaceSections(assignment.id, [{ label: "Period 1", aliases: [], canonicalKey: "1" }]);

    expect(saveGradingResult(gradingWrite(s, { fields: { flags: ["section_inferred", "fallback_model"] } }))).toBe(true);

    expect(getSubmission(s.id)).toMatchObject({
      sectionId: null, sectionSource: null, sectionKey: "3", flags: ["section_unmatched", "fallback_model"], status: "needs_review",
    });
  });

  it("drops a deleted section without a flag when no sections are left", () => {
    const s = gradingSubmission();
    replaceSections(assignment.id, []);

    saveGradingResult(gradingWrite(s, { fields: { sectionSource: "teacher" } }));

    expect(getSubmission(s.id)).toMatchObject({ sectionId: null, sectionSource: null, flags: ["fallback_model"], status: "graded" });
  });
});

describe("retry and failure transitions", () => {
  it("scheduleRetry moves grading → queued with a note, only for the current generation", () => {
    const s = gradingSubmission();
    expect(scheduleRetry(s.id, 0, "stale")).toBe(false);
    expect(scheduleRetry(s.id, 1, "Retrying after a temporary AI error")).toBe(true);
    expect(getSubmission(s.id)).toMatchObject({ status: "queued", statusNote: "Retrying after a temporary AI error" });
    expect(scheduleRetry(s.id, 1, "again")).toBe(false);
  });

  it("markFailed records the error, only for the current generation", () => {
    const s = gradingSubmission();
    expect(markFailed(s.id, 2, "unknown", "x")).toBe(false);
    expect(markFailed(s.id, 1, "max_tokens", "Too long.")).toBe(true);
    expect(getSubmission(s.id)).toMatchObject({ status: "failed", errorCode: "max_tokens", errorMessage: "Too long." });
  });

  it("markFailed does not touch a paper that already finished", () => {
    const s = seedSubmission(assignment.id, { status: "graded" });
    expect(markFailed(s.id, s.gradingGeneration, "internal", "x")).toBe(false);
  });

  it("requeueForRegrade bumps the generation and clears review and error state", () => {
    const s = seedSubmission(assignment.id, { status: "failed" });
    updateSubmission(s.id, { reviewedAt: T0 });
    db.prepare("UPDATE submissions SET error_code = 'x', error_message = 'y' WHERE id = ?").run(s.id);

    expect(requeueForRegrade(s.id)).toBe(2);
    expect(requeueForRegrade(s.id)).toBe(3);
    expect(getSubmission(s.id)).toMatchObject({
      status: "queued", gradingGeneration: 3, reviewedAt: null, errorCode: null, errorMessage: null,
    });
    expect(() => requeueForRegrade("missing")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("updateSubmission", () => {
  it("patches only the given fields and encodes flags and booleans", () => {
    const s = seedSubmission(assignment.id);
    setClockForTests(() => T0 + 9);

    const updated = updateSubmission(s.id, {
      flags: ["name_missing", "low_confidence"], overallFeedbackEdited: true, totalOverrideCenti: 0, sectionId: sections[0].id,
    });

    expect(updated).toMatchObject({
      flags: ["name_missing", "low_confidence"], overallFeedbackEdited: true, totalOverrideCenti: 0, sectionId: sections[0].id,
      status: "queued", updatedAt: T0 + 9,
    });
    expect(updateSubmission(s.id, { totalOverrideCenti: null }).totalOverrideCenti).toBeNull();
  });

  it("ignores fields that are not patchable", () => {
    const s = seedSubmission(assignment.id);
    const patch = { status: "graded", receiptToken: "hijack" } as Parameters<typeof updateSubmission>[1];
    expect(updateSubmission(s.id, patch)).toMatchObject({ status: "graded", receiptToken: s.receiptToken });
  });

  it("throws not_found for a missing submission", () => {
    expect(() => updateSubmission("missing", { status: "graded" })).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("item overrides", () => {
  it("creates an unjudged row and updates only the given fields", () => {
    const s = seedSubmission(assignment.id);

    setItemOverride(s.id, items[1].id, { overrideCenti: 50 });
    setItemOverride(s.id, items[1].id, { overrideFeedback: "Good." });
    expect(listItems(s.id)).toEqual([{
      submissionId: s.id, itemId: items[1].id, judgment: null, overrideCenti: 50, overrideFeedback: "Good.",
      overrideWhatStudentDid: null, updatedAt: T0,
    }]);

    setItemOverride(s.id, items[1].id, { overrideCenti: null, overrideWhatStudentDid: "You drew the cell." });
    expect(listItems(s.id)[0]).toMatchObject({ overrideCenti: null, overrideFeedback: "Good.", overrideWhatStudentDid: "You drew the cell." });
  });

  it("keeps the teacher's \"what you did\" note when a grading result replaces the AI's", () => {
    const s = gradingSubmission();
    setItemOverride(s.id, items[0].id, { overrideWhatStudentDid: "You got x = 4." });

    saveGradingResult(gradingWrite(s));

    expect(listItems(s.id)[0]).toMatchObject({ overrideWhatStudentDid: "You got x = 4.", judgment: judgment() });
  });

  it("getItem returns one item row, judged or not", () => {
    const s = gradingSubmission();
    saveGradingResult(gradingWrite(s, { items: [{ itemId: items[0].id, judgment: judgment() }] }));
    setItemOverride(s.id, items[1].id, { overrideCenti: 50 });

    expect(getItem(s.id, items[0].id)).toMatchObject({ itemId: items[0].id, judgment: judgment(), overrideCenti: null });
    expect(getItem(s.id, items[1].id)).toMatchObject({ itemId: items[1].id, judgment: null, overrideCenti: 50 });
    expect(getItem(s.id, items[2].id)).toBeNull();
    expect(getItem("missing", items[0].id)).toBeNull();
  });

  it("lists items in key order, per submission across the assignment", () => {
    const a = seedSubmission(assignment.id);
    const b = seedSubmission(assignment.id);
    setItemOverride(a.id, items[2].id, { overrideCenti: 1 });
    setItemOverride(a.id, items[0].id, { overrideCenti: 2 });
    setItemOverride(b.id, items[1].id, { overrideCenti: 3 });

    expect(listItems(a.id).map((i) => i.itemId)).toEqual([items[0].id, items[2].id]);
    const byId = listItemsForAssignment(assignment.id);
    expect([...byId.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(byId.get(a.id)!.map((i) => i.overrideCenti)).toEqual([2, 1]);
    expect(byId.get(b.id)!.map((i) => i.overrideCenti)).toEqual([3]);
  });
});

describe("listStaleIds", () => {
  it("returns graded and needs_review papers graded at an older key revision", () => {
    const old = gradingSubmission();
    saveGradingResult(gradingWrite(old, { keyRevision: 1 }));
    const oldReview = gradingSubmission();
    saveGradingResult(gradingWrite(oldReview, { keyRevision: 1, fields: { status: "needs_review" } }));
    const current = gradingSubmission();
    saveGradingResult(gradingWrite(current, { keyRevision: 2 }));
    seedSubmission(assignment.id);

    expect(listStaleIds(assignment.id, 2)).toEqual([old.id, oldReview.id]);
    expect(listStaleIds(assignment.id, 1)).toEqual([]);
  });
});

describe("listGuidanceStaleIds", () => {
  function graded(o: Partial<Omit<GradingWrite, "fields">> & { fields?: Partial<GradingWrite["fields"]> } = {}): Submission {
    const s = gradingSubmission();
    saveGradingResult(gradingWrite(s, { keyRevision: 2, ...o }));
    return getSubmission(s.id)!;
  }

  it("returns unreviewed papers graded at the current key revision with other guidance, oldest first", () => {
    const older = graded({ guidanceFingerprint: "old" });
    setClockForTests(() => T0 + 1);
    const none = graded({ fields: { status: "needs_review" } });
    graded({ guidanceFingerprint: "new" });

    expect(listGuidanceStaleIds(assignment.id, 2, "new")).toEqual([older.id, none.id]);
    expect(listGuidanceStaleIds(seedAssignment(teacher.id).id, 2, "new")).toEqual([]);
  });

  it("excludes reviewed, key-stale and unfinished papers", () => {
    const reviewed = graded({ guidanceFingerprint: "old" });
    updateSubmission(reviewed.id, { reviewedAt: T0 });
    graded({ keyRevision: 1, guidanceFingerprint: "old" });
    seedSubmission(assignment.id);
    seedSubmission(assignment.id, { status: "failed" });

    expect(listGuidanceStaleIds(assignment.id, 2, "new")).toEqual([]);
  });

  it("excludes papers the teacher corrected: any item override, or a total override", () => {
    const untouched = graded({ guidanceFingerprint: "old" });
    const points = graded({ guidanceFingerprint: "old" });
    setItemOverride(points.id, items[0].id, { overrideCenti: 0 });
    const feedback = graded({ guidanceFingerprint: "old" });
    setItemOverride(feedback.id, items[1].id, { overrideFeedback: "Show your work." });
    const note = graded({ guidanceFingerprint: "old" });
    setItemOverride(note.id, items[0].id, { overrideWhatStudentDid: "" });
    const total = graded({ guidanceFingerprint: "old" });
    updateSubmission(total.id, { totalOverrideCenti: 100 });
    const cleared = graded({ guidanceFingerprint: "old" });
    setItemOverride(cleared.id, items[0].id, { overrideCenti: 0 });
    setItemOverride(cleared.id, items[0].id, { overrideCenti: null });

    expect(listGuidanceStaleIds(assignment.id, 2, "new")).toEqual([untouched.id, cleared.id]);
  });

  it("treats a paper graded before guidance existed (NULL) as graded without guidance", () => {
    const legacy = graded();
    db.prepare("UPDATE submissions SET graded_guidance_fp = NULL WHERE id = ?").run(legacy.id);

    expect(listGuidanceStaleIds(assignment.id, 2, "")).toEqual([]);
    expect(listGuidanceStaleIds(assignment.id, 2, "fp")).toEqual([legacy.id]);
  });
});

describe("boot recovery", () => {
  it("resets grading papers to queued and lists queued papers without an active job", () => {
    const orphan = gradingSubmission();
    const withJob = seedSubmission(assignment.id, { source: "teacher" });
    enqueueJob({ kind: "grade_submission", targetId: withJob.id, assignmentId: assignment.id, priority: 20, maxAttempts: 4 });
    seedSubmission(assignment.id, { status: "graded" });

    expect(resetGradingToQueued()).toBe(1);
    expect(getSubmission(orphan.id)!.status).toBe("queued");
    expect(listQueuedWithoutJob()).toEqual([{ id: orphan.id, assignmentId: assignment.id, source: "student" }]);
  });
});
