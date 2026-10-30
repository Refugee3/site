import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { claimNextJob, completeJob, enqueueJob } from "@/lib/db/repos/jobs";
import {
  createEmptyKey, getKey, listKeyItems, listProcessingKeysWithoutJob, recentExtractionDurations, replaceKeyItems, updateKey, upsertKeyItems,
} from "@/lib/db/repos/keys";
import { listItems, setItemOverride } from "@/lib/db/repos/submissions";
import { seedApprovedKey, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";
import type { Assignment, NewKeyItem } from "@/lib/types";

const T0 = 1_700_000_000_000;

let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
});

function item(label: string, o: Partial<NewKeyItem> = {}): NewKeyItem {
  return {
    label,
    groupLabel: "",
    prompt: `Question ${label}`,
    answerType: "numeric",
    expectedAnswer: "4",
    acceptableAnswers: ["4.0"],
    gradingCriteria: "",
    pointsCenti: 100,
    partialCredit: false,
    page: 1,
    answerSource: "key",
    aiConfidence: "high",
    aiNote: "",
    ...o,
  };
}

describe("answer key row", () => {
  it("seedAssignment creates an empty key with defaults", () => {
    expect(getKey(assignment.id)).toEqual({
      assignmentId: assignment.id, status: "empty", sourcePdfPath: null, sourceFilename: null, sourceSha256: null,
      sourcePageCount: null, documentKind: null, teacherNotes: "", aiNotes: "", revision: 0, approvedRevision: null,
      fingerprint: null, errorMessage: null, aiModel: null, usage: null, processingStartedAt: null, processingFinishedAt: null, updatedAt: T0,
    });
    expect(getKey("missing")).toBeNull();
  });

  it("createEmptyKey refuses a second key for the same assignment", () => {
    expect(() => createEmptyKey(assignment.id)).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("updateKey patches fields, round-trips usage JSON and bumps updated_at", () => {
    setClockForTests(() => T0 + 7);
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };

    const key = updateKey(assignment.id, { status: "processing", sourcePdfPath: "files/a/key/b.pdf", usage, errorMessage: null });

    expect(key).toMatchObject({ status: "processing", sourcePdfPath: "files/a/key/b.pdf", usage, updatedAt: T0 + 7 });
    expect(updateKey(assignment.id, { usage: null }).usage).toBeNull();
    expect(() => updateKey("missing", { status: "ready" })).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("key items", () => {
  it("replaceKeyItems inserts items in order with fresh ids", () => {
    const first = replaceKeyItems(assignment.id, [item("1"), item("2", { partialCredit: true, aiConfidence: null })]);
    expect(first.map((i) => [i.label, i.position, i.partialCredit, i.aiConfidence, i.acceptableAnswers])).toEqual([
      ["1", 0, false, "high", ["4.0"]], ["2", 1, true, null, ["4.0"]],
    ]);

    const second = replaceKeyItems(assignment.id, [item("A")]);
    expect(second.map((i) => i.label)).toEqual(["A"]);
    expect(second[0].id).not.toBe(first[0].id);
    expect(listKeyItems(assignment.id)).toEqual(second);
  });

  it("upsertKeyItems updates known ids, inserts the rest, deletes absent items and reorders", () => {
    const [q1, q2, q3] = replaceKeyItems(assignment.id, [item("1"), item("2"), item("3")]);
    const other = seedAssignment(seedTeacher().id);
    const [foreign] = replaceKeyItems(other.id, [item("X")]);

    const saved = upsertKeyItems(assignment.id, [
      { ...item("3", { expectedAnswer: "five" }), id: q3.id },
      { ...item("new"), id: null },
      { ...item("1"), id: q1.id },
      { ...item("stolen"), id: foreign.id },
      { ...item("dup"), id: q1.id },
    ]);

    expect(saved.map((i) => [i.label, i.position])).toEqual([["3", 0], ["new", 1], ["1", 2], ["stolen", 3], ["dup", 4]]);
    expect(saved[0]).toMatchObject({ id: q3.id, expectedAnswer: "five" });
    expect(saved[2].id).toBe(q1.id);
    expect(saved.map((i) => i.id)).not.toContain(q2.id);
    expect(saved.map((i) => i.id)).not.toContain(foreign.id);
    expect(new Set(saved.map((i) => i.id)).size).toBe(5);
    expect(listKeyItems(other.id)).toEqual([foreign]);
  });

  it("upsertKeyItems keeps judgments and overrides of kept items and drops those of deleted items", () => {
    const [keep, drop] = seedApprovedKey(assignment.id, [{}, {}]);
    const s = seedSubmission(assignment.id);
    setItemOverride(s.id, keep.id, { overrideCenti: 10 });
    setItemOverride(s.id, drop.id, { overrideCenti: 20 });

    upsertKeyItems(assignment.id, [{ ...keep, pointsCenti: 300 }]);

    expect(listItems(s.id)).toMatchObject([{ itemId: keep.id, overrideCenti: 10 }]);
  });
});

describe("listProcessingKeysWithoutJob", () => {
  it("lists processing keys that have no queued or running extraction job", () => {
    const withQueued = seedAssignment(seedTeacher().id);
    const withRunning = seedAssignment(seedTeacher().id);
    const withFinished = seedAssignment(seedTeacher().id);
    for (const a of [assignment, withQueued, withRunning, withFinished]) updateKey(a.id, { status: "processing" });
    seedAssignment(seedTeacher().id);

    const extract = (a: Assignment) => enqueueJob({ kind: "extract_key", targetId: a.id, assignmentId: a.id, priority: 0, maxAttempts: 4 });
    extract(withFinished);
    completeJob(claimNextJob(T0)!.id);
    extract(withRunning);
    claimNextJob(T0);
    extract(withQueued);
    enqueueJob({ kind: "grade_submission", targetId: assignment.id, assignmentId: assignment.id, priority: 10, maxAttempts: 4 });

    expect(listProcessingKeysWithoutJob().sort()).toEqual([assignment.id, withFinished.id].sort());
  });

  it("ignores keys that are not processing", () => {
    updateKey(assignment.id, { status: "failed" });
    expect(listProcessingKeysWithoutJob()).toEqual([]);
  });
});

describe("recentExtractionDurations", () => {
  it("lists how long recent key readings took, newest first, over every assignment", () => {
    const other = seedAssignment(seedTeacher().id);
    updateKey(assignment.id, { processingStartedAt: T0, processingFinishedAt: T0 + 40_000 });
    updateKey(other.id, { processingStartedAt: T0 + 100_000, processingFinishedAt: T0 + 120_000 });
    const unfinished = seedAssignment(seedTeacher().id);
    updateKey(unfinished.id, { status: "processing", processingStartedAt: T0 });

    expect(recentExtractionDurations(20)).toEqual([20_000, 40_000]);
    expect(recentExtractionDurations(1)).toEqual([20_000]);
  });
});
