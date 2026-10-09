import { describe, expect, it } from "vitest";
import type { KeyExtraction } from "@/lib/ai/schemas";
import { defaultPartialCredit, isKeyApproved, keyFingerprint, normalizeExtractedKey, validateSaveKey } from "@/lib/grading/key";
import { makeKeyItem } from "@/lib/grading/test-utils";
import type { AnswerKey, KeyItem, SaveKeyInput } from "@/lib/types";

type ExtractedItem = KeyExtraction["items"][number];

function extractedItem(o: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    label: "1", group_label: "", prompt: "Solve 3/x = 9/12.", answer_type: "numeric", expected_answer: "x = 4",
    acceptable_answers: ["4"], grading_criteria: "", points: null, group_points: null, page: 1, answer_source: "key", confidence: "high",
    note: "", ...o,
  };
}

function extraction(items: ExtractedItem[], o: Partial<KeyExtraction> = {}): KeyExtraction {
  return { document_kind: "answer_key", items, stated_total_points: null, notes: "", ...o };
}

const OPTIONS = { pageCount: 3, maxItems: 200 };

describe("normalizeExtractedKey", () => {
  it("maps fields and fills defaults", () => {
    const { items, fatal, aiNotes } = normalizeExtractedKey(extraction([
      extractedItem({ label: "  1 ", answer_type: "multiple_choice", confidence: "medium", note: " Faint scan. " }),
      extractedItem({ label: "", group_label: " 3 ", answer_type: "short_answer", answer_source: "ai_proposed", page: 1.6 }),
    ]), OPTIONS);
    expect(fatal).toBeNull();
    expect(aiNotes).toBe("");
    expect(items[0]).toEqual({
      label: "1", groupLabel: "", prompt: "Solve 3/x = 9/12.", answerType: "multiple_choice", expectedAnswer: "x = 4",
      acceptableAnswers: ["4"], gradingCriteria: "", pointsCenti: 100, partialCredit: false, page: 1, answerSource: "key",
      aiConfidence: "medium", aiNote: "Faint scan.",
    });
    expect(items[1]).toMatchObject({ label: "2", groupLabel: "3", partialCredit: true, page: 2, answerSource: "ai_proposed" });
  });

  it("converts points to centipoints and clamps them to the allowed range with a note", () => {
    const { items } = normalizeExtractedKey(extraction([
      extractedItem({ points: 2.5 }), extractedItem({ points: 0 }), extractedItem({ points: 5000 }), extractedItem({ points: 0.333 }),
    ]), OPTIONS);
    expect(items.map((item) => item.pointsCenti)).toEqual([250, 1, 100_000, 33]);
    expect(items[0].aiNote).toBe("");
    expect(items[1].aiNote).toContain("0 points were outside the allowed range");
    expect(items[2].aiNote).toContain("5000 points were outside the allowed range and became 1000");
  });

  it("drops pages outside the document", () => {
    const { items } = normalizeExtractedKey(extraction([
      extractedItem({ page: 0 }), extractedItem({ page: 4 }), extractedItem({ page: 3.4 }), extractedItem({ page: null }),
    ]), OPTIONS);
    expect(items.map((item) => item.page)).toEqual([null, null, 3, null]);
  });

  it("caps text fields and accepted answers", () => {
    const { items } = normalizeExtractedKey(extraction([extractedItem({
      label: "L".repeat(50), group_label: "G".repeat(50), prompt: "p".repeat(1500), expected_answer: "e".repeat(2500),
      grading_criteria: "c".repeat(1500), note: "n".repeat(800),
      acceptable_answers: ["", ...Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(600, "a"))],
    })]), OPTIONS);
    const [item] = items;
    expect([item.label.length, item.groupLabel.length, item.prompt.length, item.expectedAnswer.length, item.gradingCriteria.length, item.aiNote.length])
      .toEqual([40, 40, 1000, 2000, 1000, 500]);
    expect(item.acceptableAnswers).toHaveLength(20);
    expect(item.acceptableAnswers.every((answer) => answer.length === 500)).toBe(true);
    expect(item.acceptableAnswers[0].startsWith("0")).toBe(true);
  });

  it("splits a stated total equally when no item has points, remainder on the last item", () => {
    const { items, aiNotes } = normalizeExtractedKey(
      extraction([extractedItem(), extractedItem(), extractedItem()], { stated_total_points: 10 }),
      OPTIONS,
    );
    expect(items.map((item) => item.pointsCenti)).toEqual([333, 333, 334]);
    expect(aiNotes).toBe("");
  });

  it("does not split a total that is too small or when some item has points", () => {
    const tiny = normalizeExtractedKey(extraction([extractedItem(), extractedItem(), extractedItem()], { stated_total_points: 0.02 }), OPTIONS);
    expect(tiny.items.map((item) => item.pointsCenti)).toEqual([100, 100, 100]);
    expect(tiny.aiNotes).toBe("Key total 0.02 differs from the sum of item points 3.");

    const mixed = normalizeExtractedKey(extraction([extractedItem({ points: 4 }), extractedItem()], { stated_total_points: 10 }), OPTIONS);
    expect(mixed.items.map((item) => item.pointsCenti)).toEqual([400, 100]);
    expect(mixed.aiNotes).toBe("Key total 10 differs from the sum of item points 5.");
  });

  describe("a total stated only for a whole question (group_points)", () => {
    const part = (label: string, o: Partial<ExtractedItem> = {}) =>
      extractedItem({ label, group_label: label.replace(/\D+$/, ""), group_points: 6, ...o });

    it("splits it equally across the question's parts next to items with their own points", () => {
      const { items, aiNotes } = normalizeExtractedKey(extraction([
        extractedItem({ label: "1", points: 2 }), part("2a", { note: "Question 2 is worth 6 pts total." }), part("2b"), part("2c"),
      ]), OPTIONS);
      expect(items.map((item) => item.pointsCenti)).toEqual([200, 200, 200, 200]);
      expect(items[0].aiNote).toBe("");
      expect(items[1].aiNote).toBe("Question 2 is worth 6 pts total. Split from question 2's 6 points.");
      expect(items[2].aiNote).toBe("Split from question 2's 6 points.");
      expect(aiNotes).toBe("");
    });

    it("puts the remainder of an uneven split on the last part", () => {
      const { items } = normalizeExtractedKey(extraction([
        part("3a", { group_points: 10 }), part("3b", { group_points: 10 }), part("3c", { group_points: 10 }),
      ]), OPTIONS);
      expect(items.map((item) => item.pointsCenti)).toEqual([333, 333, 334]);
    });

    it("splits only what the parts with their own points leave over", () => {
      const { items } = normalizeExtractedKey(extraction([
        part("2a", { points: 2, group_points: null }), part("2b"), part("2c"), extractedItem({ label: "3", points: 1 }),
      ]), OPTIONS);
      expect(items.map((item) => item.pointsCenti)).toEqual([200, 200, 200, 100]);
    });

    it("keeps separate questions apart and gives a lone item the whole total without a note", () => {
      const { items } = normalizeExtractedKey(extraction([
        part("1a", { group_points: 4 }), part("1b", { group_points: 4 }), part("2a", { group_points: 3 }),
        extractedItem({ label: "3", group_points: 5 }),
      ]), OPTIONS);
      expect(items.map((item) => item.pointsCenti)).toEqual([200, 200, 300, 500]);
      expect(items[3].aiNote).toBe("");
    });

    it("keeps the default with a note when the total is too small to split", () => {
      const { items } = normalizeExtractedKey(extraction([
        part("2a", { group_points: 0.01 }), part("2b", { group_points: 0.01 }),
      ]), OPTIONS);
      expect(items.map((item) => item.pointsCenti)).toEqual([100, 100]);
      expect(items[0].aiNote).toBe("Question 2's 0.01 points could not be split across its parts; check these points.");
    });

    it("clamps a share above the maximum with a note", () => {
      const { items } = normalizeExtractedKey(extraction([part("2a", { group_points: 5000 }), part("2b", { group_points: 5000 })]), OPTIONS);
      expect(items.map((item) => item.pointsCenti)).toEqual([100_000, 100_000]);
      expect(items[0].aiNote).toBe("Split from question 2's 5000 points. The key's 2500 points were outside the allowed range and became 1000.");
    });

    it("takes precedence over splitting the stated document total, and the total check still runs", () => {
      const matching = normalizeExtractedKey(extraction([
        extractedItem({ label: "1", points: 2 }), part("2a"), part("2b"), part("2c"),
      ], { stated_total_points: 8 }), OPTIONS);
      expect(matching.items.map((item) => item.pointsCenti)).toEqual([200, 200, 200, 200]);
      expect(matching.aiNotes).toBe("");

      const unpointed = normalizeExtractedKey(extraction([extractedItem({ label: "1" }), part("2a"), part("2b")],
        { stated_total_points: 10 }), OPTIONS);
      expect(unpointed.items.map((item) => item.pointsCenti)).toEqual([100, 300, 300]);
      expect(unpointed.aiNotes).toBe("Key total 10 differs from the sum of item points 7.");
    });
  });

  it("builds the AI notes from the model's notes, the total check and a blank-worksheet warning", () => {
    const { aiNotes, fatal } = normalizeExtractedKey(
      extraction([extractedItem({ points: 1 })], { document_kind: "blank_worksheet", notes: " Page 2 looks cut off. ", stated_total_points: 1 }),
      OPTIONS,
    );
    expect(fatal).toBeNull();
    expect(aiNotes.split("\n")).toEqual([
      "Page 2 looks cut off.",
      "This looks like a blank worksheet, so the AI proposed the answers itself. Check every answer before approving.",
    ]);
  });

  it("caps the model's notes without cutting off the checks", () => {
    const { aiNotes } = normalizeExtractedKey(
      extraction([extractedItem({ points: 1 })], { notes: "n".repeat(3000), stated_total_points: 5 }),
      OPTIONS,
    );
    const [modelNotes, totalCheck] = aiNotes.split("\n");
    expect(modelNotes).toHaveLength(2000);
    expect(totalCheck).toBe("Key total 5 differs from the sum of item points 1.");
  });

  it.each<[string, KeyExtraction, string]>([
    ["student work", extraction([extractedItem()], { document_kind: "student_work" }), "This looks like a student's paper"],
    ["an unrelated document", extraction([extractedItem()], { document_kind: "unrelated" }), "doesn't look like an answer key"],
    ["no items", extraction([]), "No questions found"],
    ["too many items", extraction(Array.from({ length: 4 }, () => extractedItem())), "more than 3 items"],
  ])("fails for %s", (_name, x, message) => {
    const result = normalizeExtractedKey(x, { pageCount: 3, maxItems: 3 });
    expect(result.fatal).toContain(message);
    expect(result.items).toEqual([]);
  });
});

describe("keyFingerprint", () => {
  const items = [
    makeKeyItem({ id: "a", label: "1", expectedAnswer: "4", pointsCenti: 100, position: 0 }),
    makeKeyItem({ id: "b", label: "2", expectedAnswer: "x", pointsCenti: 200, position: 1 }),
  ];
  const base = keyFingerprint(items, "notes");

  it("is a sha256 hex digest", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores points, partial credit, order, page and provenance", () => {
    const edited = [
      { ...items[1], pointsCenti: 900, position: 0, partialCredit: false, page: 2 },
      { ...items[0], position: 1, answerSource: "ai_proposed" as const, aiConfidence: "low" as const, aiNote: "check" },
    ];
    expect(keyFingerprint(edited, "notes")).toBe(base);
  });

  it("changes when the expected answer, accepted answers or teacher notes change", () => {
    expect(keyFingerprint([{ ...items[0], expectedAnswer: "5" }, items[1]], "notes")).not.toBe(base);
    expect(keyFingerprint([{ ...items[0], acceptableAnswers: ["four"] }, items[1]], "notes")).not.toBe(base);
    expect(keyFingerprint(items, "other notes")).not.toBe(base);
  });
});

describe("validateSaveKey", () => {
  type Row = SaveKeyInput["items"][number];
  const row = (o: Partial<Row> = {}): Row => ({
    id: null, label: "1", groupLabel: "", prompt: "", answerType: "short_answer", expectedAnswer: "x", acceptableAnswers: [],
    gradingCriteria: "", pointsCenti: 100, partialCredit: true, page: null, ...o,
  });
  const input = (items: Row[], o: Partial<SaveKeyInput> = {}): SaveKeyInput => ({ teacherNotes: "", acknowledgeAiProposed: false, items, ...o });
  const OPTS = { maxItems: 200 };

  const fromKey = makeKeyItem({ id: "key-item", answerSource: "key", aiConfidence: "medium", aiNote: "faint" });
  const proposed = makeKeyItem({ id: "proposed-item", answerSource: "ai_proposed", aiConfidence: "low", aiNote: "my guess" });
  const current: KeyItem[] = [fromKey, proposed];

  it("requires the acknowledgement while an AI-proposed row is kept", () => {
    const result = validateSaveKey(input([row({ id: proposed.id })]), current, OPTS);
    expect(result).toMatchObject({ ok: false, fieldErrors: { acknowledgeAiProposed: [expect.any(String)] } });
  });

  it("turns acknowledged AI-proposed rows into teacher rows and keeps their AI metadata", () => {
    const result = validateSaveKey(input([row({ id: proposed.id }), row({ id: fromKey.id, label: " 2 " })], {
      acknowledgeAiProposed: true, teacherNotes: "  Units required.  ",
    }), current, OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.teacherNotes).toBe("Units required.");
    expect(result.items[0]).toMatchObject({ id: proposed.id, answerSource: "teacher", aiConfidence: "low", aiNote: "my guess" });
    expect(result.items[1]).toMatchObject({ id: fromKey.id, label: "2", answerSource: "key", aiConfidence: "medium", aiNote: "faint" });
  });

  it("does not need the acknowledgement once AI-proposed rows are deleted", () => {
    expect(validateSaveKey(input([row({ id: fromKey.id })]), current, OPTS).ok).toBe(true);
  });

  it("treats unknown and repeated ids as new teacher rows", () => {
    const result = validateSaveKey(input([row({ id: fromKey.id }), row({ id: fromKey.id }), row({ id: "someone-elses" })]), current, OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => [item.id, item.answerSource, item.aiConfidence, item.aiNote])).toEqual([
      [fromKey.id, "key", "medium", "faint"], [null, "teacher", null, ""], [null, "teacher", null, ""],
    ]);
  });

  it("trims text and drops empty accepted answers", () => {
    const result = validateSaveKey(input([row({ prompt: " Q ", expectedAnswer: " 4 ", acceptableAnswers: [" four ", "  "] })]), [], OPTS);
    expect(result.ok && result.items[0]).toMatchObject({ prompt: "Q", expectedAnswer: "4", acceptableAnswers: ["four"] });
  });

  it("reports field errors by row and field", () => {
    const result = validateSaveKey(input([
      row(),
      row({ label: "  ", pointsCenti: 0, page: 0 }),
      row({ label: "x".repeat(41), groupLabel: "g".repeat(41), prompt: "p".repeat(1001), expectedAnswer: "e".repeat(2001),
        gradingCriteria: "c".repeat(1001), pointsCenti: 100_001, page: 1.5 }),
      row({ acceptableAnswers: Array.from({ length: 21 }, () => "a"), pointsCenti: 2.5 }),
      row({ acceptableAnswers: ["a".repeat(501)], answerType: "essay" as never }),
    ], { teacherNotes: "n".repeat(4001) }), [], OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual([
      "items.1.label", "items.1.page", "items.1.pointsCenti",
      "items.2.expectedAnswer", "items.2.gradingCriteria", "items.2.groupLabel", "items.2.label", "items.2.page",
      "items.2.pointsCenti", "items.2.prompt",
      "items.3.acceptableAnswers", "items.3.pointsCenti",
      "items.4.acceptableAnswers", "items.4.answerType",
      "teacherNotes",
    ]);
  });

  it("accepts the boundary values", () => {
    const result = validateSaveKey(input([row({ label: "x".repeat(40), pointsCenti: 1, page: 1 }), row({ pointsCenti: 100_000 })], {
      teacherNotes: "n".repeat(4000),
    }), [], OPTS);
    expect(result.ok).toBe(true);
  });

  it("needs between 1 and maxItems rows", () => {
    expect(validateSaveKey(input([]), [], OPTS)).toMatchObject({ ok: false, error: "Add at least one item to the key." });
    expect(validateSaveKey(input([row(), row(), row()]), [], { maxItems: 2 })).toMatchObject({ ok: false });
  });
});

describe("defaultPartialCredit", () => {
  it("is off for all-or-nothing answer types only", () => {
    expect(["multiple_choice", "true_false", "matching"].map((t) => defaultPartialCredit(t as never))).toEqual([false, false, false]);
    expect(["numeric", "short_answer", "long_answer", "fill_in_blank", "diagram", "other"].every((t) => defaultPartialCredit(t as never)))
      .toBe(true);
  });
});

describe("isKeyApproved", () => {
  const key = (o: Partial<AnswerKey>): AnswerKey => ({
    assignmentId: "a", status: "ready", sourcePdfPath: null, sourceFilename: null, sourceSha256: null, sourcePageCount: null,
    documentKind: null, teacherNotes: "", aiNotes: "", revision: 2, approvedRevision: 2, fingerprint: null, errorMessage: null,
    aiModel: null, usage: null, processingStartedAt: null, processingFinishedAt: null, updatedAt: 0, ...o,
  });

  it("needs a ready key, approved at the current revision, with items", () => {
    expect(isKeyApproved(key({}), 1)).toBe(true);
    expect(isKeyApproved(key({}), 0)).toBe(false);
    expect(isKeyApproved(key({ approvedRevision: 1 }), 3)).toBe(false);
    expect(isKeyApproved(key({ approvedRevision: null }), 3)).toBe(false);
    expect(isKeyApproved(key({ status: "processing" }), 3)).toBe(false);
  });
});
