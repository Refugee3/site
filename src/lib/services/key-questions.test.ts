import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getAssignment, listAssignmentsForTeacher } from "@/lib/db/repos/assignments";
import { listKeyQuestions } from "@/lib/db/repos/key-questions";
import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import { isKeyApproved } from "@/lib/grading/key";
import { NOTES_HEADING } from "@/lib/grading/key-questions";
import { FAKE_META, drainQueue, scriptedGrader } from "@/lib/jobs/test-utils";
import { createAssignmentFromKey, renameAssignment } from "@/lib/services/assignments";
import { answerKeyQuestions, approveKeyAsIs } from "@/lib/services/key-questions";
import { ingestKeyPdf, retryKeyExtraction } from "@/lib/services/keys";
import type { Assignment, Teacher } from "@/lib/types";
import { makePdf, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";

let clock = 1_700_000_000_000;
let teacher: Teacher;

beforeEach(() => {
  clock = 1_700_000_000_000;
  setClockForTests(() => clock);
  useTestDb();
  teacher = seedTeacher();
});

async function readKey(a: Assignment): Promise<void> {
  await ingestKeyPdf(a, { filename: "key.pdf", bytes: await makePdf(2, { label: "key" }) });
  clock += 1000;
  await drainQueue();
}

describe("reading a key stores the AI's questions and names an untitled assignment", () => {
  it("stores the fake grader's two questions, pending, and replaces the placeholder title", async () => {
    const a = await createAssignmentFromKey(teacher.id, "quiz", [{ filename: "key.pdf", bytes: await makePdf(1, { label: "key" }) }]);
    expect(a).toMatchObject({ title: "Untitled quiz", kind: "quiz" });
    expect(getKey(a.id)?.status).toBe("processing");

    await drainQueue();

    expect(getAssignment(a.id)?.title).toBe("Plants and Photosynthesis");
    expect(listKeyQuestions(a.id).map((q) => [q.kind, q.itemLabel, q.status, q.answer])).toEqual([
      ["missing_answer", "4", "pending", null],
      ["accept_equivalents", "3a", "pending", null],
    ]);
  });

  it("keeps a title the teacher chose", async () => {
    const a = seedAssignment(teacher.id, { title: "Unit 4 Quiz" });
    await readKey(a);
    expect(getAssignment(a.id)?.title).toBe("Unit 4 Quiz");

    const renamed = await createAssignmentFromKey(teacher.id, "homework", [{ filename: "k.pdf", bytes: await makePdf(1, { label: "k" }) }]);
    renameAssignment(renamed, "  My own title ");
    await drainQueue();
    expect(getAssignment(renamed.id)?.title).toBe("My own title");
  });

  it("replaces the questions on each reading and drops them while a new one is read or when it fails", async () => {
    const a = seedAssignment(teacher.id);
    await readKey(a);
    const first = listKeyQuestions(a.id).map((q) => q.id);
    expect(first).toHaveLength(2);

    retryKeyExtraction(a);
    expect(listKeyQuestions(a.id)).toEqual([]);
    await drainQueue();
    const second = listKeyQuestions(a.id).map((q) => q.id);
    expect(second).toHaveLength(2);
    expect(second.some((id) => first.includes(id))).toBe(false);

    retryKeyExtraction(a);
    await drainQueue(scriptedGrader({
      async extractKey() {
        return {
          output: { document_kind: "student_work", items: [], stated_total_points: null, notes: "", questions_for_teacher: [
            { id: "q1", kind: "other", item_label: null, question: "Ignored?", suggested_answer: null, choices: [] },
          ], suggested_title: "Not a key" },
          meta: FAKE_META,
        };
      },
    }));
    expect(getKey(a.id)?.status).toBe("failed");
    expect(listKeyQuestions(a.id)).toEqual([]);
  });

  it("creates nothing when the dropped key can't be stored", async () => {
    await expect(createAssignmentFromKey(teacher.id, "homework", [{ filename: "notes.pdf", bytes: new TextEncoder().encode("not a pdf") }]))
      .rejects.toMatchObject({ code: expect.any(String) });
    expect(listAssignmentsForTeacher(teacher.id)).toEqual([]);
  });
});

describe("answerKeyQuestions", () => {
  let a: Assignment;

  beforeEach(async () => {
    a = seedAssignment(teacher.id);
    await readKey(a);
  });

  it("applies the answers without approving the key, so no acknowledgement is needed after answering the AI-proposed one", () => {
    const [missing, equivalents] = listKeyQuestions(a.id);
    const before = getKey(a.id)!;
    clock += 1000;

    const result = answerKeyQuestions(a, [
      { id: missing.id, answer: "Cell wall, membrane, nucleus and chloroplasts, all labeled." },
      { id: equivalents.id, answer: "Yes" },
    ]);

    expect(result).toEqual({ answered: 2, skipped: 0, changedItems: 2, notes: 1 });
    const items = listKeyItems(a.id);
    expect(items.find((i) => i.label === "4")).toMatchObject({
      expectedAnswer: "Cell wall, membrane, nucleus and chloroplasts, all labeled.", answerSource: "teacher",
    });
    expect(items.find((i) => i.label === "3a")?.gradingCriteria).toContain("Accept equivalent forms");
    expect(items.some((i) => i.answerSource === "ai_proposed")).toBe(false);
    const key = getKey(a.id)!;
    expect(key.teacherNotes).toBe(`${NOTES_HEADING}\n- ${equivalents.question} Answer: Yes`);
    expect(key.revision).toBe(before.revision + 1);
    expect(isKeyApproved(key, items.length)).toBe(false);
    expect(listKeyQuestions(a.id).map((q) => q.status)).toEqual(["answered", "answered"]);

    // Approving now needs no acknowledgement: no answer is the AI's any more.
    approveKeyAsIs(a, { acknowledgeAiProposed: false, seenUpdatedAt: key.updatedAt });
    expect(isKeyApproved(getKey(a.id)!, items.length)).toBe(true);
  });

  it("skips blank answers, ignores questions already answered, and refuses unknown ones", () => {
    const [missing, equivalents] = listKeyQuestions(a.id);
    expect(answerKeyQuestions(a, [{ id: missing.id, answer: "  " }, { id: equivalents.id, answer: null }]))
      .toEqual({ answered: 0, skipped: 2, changedItems: 0, notes: 0 });
    expect(listKeyQuestions(a.id).map((q) => q.status)).toEqual(["skipped", "skipped"]);
    expect(answerKeyQuestions(a, [{ id: missing.id, answer: "Late answer" }]).answered).toBe(0);
    expect(listKeyItems(a.id).find((i) => i.label === "4")?.answerSource).toBe("ai_proposed");
    expect(() => answerKeyQuestions(a, [{ id: "nope", answer: "x" }])).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("keeps the acknowledgement when the AI-proposed answer was skipped", () => {
    const [missing] = listKeyQuestions(a.id);
    answerKeyQuestions(a, [{ id: missing.id, answer: null }]);
    const key = getKey(a.id)!;
    expect(() => approveKeyAsIs(a, { acknowledgeAiProposed: false, seenUpdatedAt: key.updatedAt }))
      .toThrow(expect.objectContaining({ code: "validation" }));
    approveKeyAsIs(a, { acknowledgeAiProposed: true, seenUpdatedAt: key.updatedAt });
    expect(isKeyApproved(getKey(a.id)!, listKeyItems(a.id).length)).toBe(true);
  });

  it("refuses answers once the key is approved, and approval skips the questions left", () => {
    const key = getKey(a.id)!;
    approveKeyAsIs(a, { acknowledgeAiProposed: true, seenUpdatedAt: key.updatedAt });
    expect(listKeyQuestions(a.id).map((q) => q.status)).toEqual(["skipped", "skipped"]);
    const [missing] = listKeyQuestions(a.id);
    expect(() => answerKeyQuestions(a, [{ id: missing.id, answer: "x" }])).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });
});

describe("approveKeyAsIs", () => {
  it("refuses a key that changed since the teacher saw it", async () => {
    const a = seedAssignment(teacher.id);
    await readKey(a);
    const seen = getKey(a.id)!.updatedAt;
    clock += 1000;
    const [missing] = listKeyQuestions(a.id);
    answerKeyQuestions(a, [{ id: missing.id, answer: "A labeled plant cell." }]);
    expect(() => approveKeyAsIs(a, { acknowledgeAiProposed: true, seenUpdatedAt: seen })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(isKeyApproved(getKey(a.id)!, listKeyItems(a.id).length)).toBe(false);
  });
});

describe("renameAssignment", () => {
  it("trims and validates the title", () => {
    const a = seedAssignment(teacher.id);
    expect(renameAssignment(a, "  Unit 5 ").title).toBe("Unit 5");
    expect(() => renameAssignment(a, "   ")).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => renameAssignment(a, "x".repeat(201))).toThrow(expect.objectContaining({ code: "validation" }));
  });
});
