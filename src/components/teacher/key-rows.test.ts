import { describe, expect, it } from "vitest";
import type { KeyItem } from "@/lib/types";
import {
  buildSaveKeyInput, describeErrors, draftFromItem, draftsSnapshot, isUncertain, needsAcknowledgement, newDraftRow,
  nextLabel, parseItemPoints, rowErrors, totalPointsCenti, type DraftRow,
} from "./key-rows";

function keyItem(o: Partial<KeyItem> = {}): KeyItem {
  return {
    id: "item-1", assignmentId: "a1", position: 0, label: "1", groupLabel: "", prompt: "Solve 3/x = 9/12.",
    answerType: "numeric", expectedAnswer: "x = 4", acceptableAnswers: ["4", "x=4.0"], gradingCriteria: "Show work.",
    pointsCenti: 150, partialCredit: true, page: 2, answerSource: "key", aiConfidence: "high", aiNote: "", ...o,
  };
}

function draft(o: Partial<DraftRow> = {}): DraftRow {
  return { ...draftFromItem(keyItem()), ...o };
}

describe("draftFromItem", () => {
  it("turns numbers and lists into editable text", () => {
    const row = draftFromItem(keyItem());
    expect(row).toMatchObject({ key: "item-1", id: "item-1", pointsText: "1.5", pageText: "2", acceptableText: "4\nx=4.0" });
    expect(draftFromItem(keyItem({ page: null, pointsCenti: 1000 }))).toMatchObject({ pageText: "", pointsText: "10" });
  });
});

describe("newDraftRow", () => {
  it("starts a fresh key at item 1", () => {
    expect(newDraftRow("k1")).toMatchObject({
      key: "k1", id: null, label: "1", answerType: "short_answer", pointsText: "1", partialCredit: true, answerSource: "teacher",
    });
  });

  it("continues numbering, parts and settings from the previous row", () => {
    const previous = draft({ label: "4", answerType: "multiple_choice", pointsText: "2", partialCredit: false, pageText: "3" });
    expect(newDraftRow("k2", previous)).toMatchObject({
      label: "5", groupLabel: "", answerType: "multiple_choice", pointsText: "2", partialCredit: false, pageText: "3",
      expectedAnswer: "", aiConfidence: null, aiNote: "",
    });
    expect(newDraftRow("k3", draft({ label: "3a", groupLabel: "3" }))).toMatchObject({ label: "3b", groupLabel: "3" });
  });
});

describe("nextLabel", () => {
  it("increments numbers and part letters, and gives up on anything else", () => {
    expect(nextLabel("9")).toBe("10");
    expect(nextLabel(" 2b ")).toBe("2c");
    expect(nextLabel("2z")).toBe("");
    expect(nextLabel("IV.2")).toBe("");
    expect(nextLabel("Bonus")).toBe("");
  });
});

describe("row state", () => {
  it("tints low and medium AI confidence only", () => {
    expect(isUncertain(draft({ aiConfidence: "low" }))).toBe(true);
    expect(isUncertain(draft({ aiConfidence: "medium" }))).toBe(true);
    expect(isUncertain(draft({ aiConfidence: "high" }))).toBe(false);
    expect(isUncertain(draft({ aiConfidence: null }))).toBe(false);
  });

  it("needs the acknowledgement while an AI-proposed row remains", () => {
    expect(needsAcknowledgement([draft(), draft({ answerSource: "ai_proposed" })])).toBe(true);
    expect(needsAcknowledgement([draft(), draft({ answerSource: "teacher" })])).toBe(false);
  });
});

describe("parseItemPoints", () => {
  it("requires a positive number of at most 1000", () => {
    expect(parseItemPoints("2.5")).toEqual({ ok: true, centi: 250 });
    expect(parseItemPoints("1000")).toEqual({ ok: true, centi: 100000 });
    expect(parseItemPoints("").ok).toBe(false);
    expect(parseItemPoints("0").ok).toBe(false);
    expect(parseItemPoints("1000.01").ok).toBe(false);
    expect(parseItemPoints("1,5").ok).toBe(false);
  });

  it("sums only valid points", () => {
    expect(totalPointsCenti([draft({ pointsText: "1.5" }), draft({ pointsText: "x" }), draft({ pointsText: "2" })])).toBe(350);
  });
});

describe("buildSaveKeyInput", () => {
  it("builds the payload with parsed numbers and trimmed, non-empty accepted answers", () => {
    const result = buildSaveKeyInput([draft({ acceptableText: " 4 \n\n x = 4.0 ", pageText: "" })], "Units required.", false);
    expect(result).toEqual({
      ok: true,
      input: {
        teacherNotes: "Units required.",
        acknowledgeAiProposed: false,
        items: [{
          id: "item-1", label: "1", groupLabel: "", prompt: "Solve 3/x = 9/12.", answerType: "numeric", expectedAnswer: "x = 4",
          acceptableAnswers: ["4", "x = 4.0"], gradingCriteria: "Show work.", pointsCenti: 150, partialCredit: true, page: null,
        }],
      },
    });
  });

  it("reports label, points and page mistakes under the server's field keys", () => {
    const result = buildSaveKeyInput([draft(), draft({ label: " ", pointsText: "0", pageText: "0" })], "", false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(["items.1.label", "items.1.page", "items.1.pointsCenti"]);
  });

  it("requires the acknowledgement for AI-proposed rows", () => {
    const rows = [draft({ answerSource: "ai_proposed" })];
    const refused = buildSaveKeyInput(rows, "", false);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.fieldErrors.acknowledgeAiProposed).toHaveLength(1);
    expect(buildSaveKeyInput(rows, "", true).ok).toBe(true);
  });
});

describe("errors", () => {
  const fieldErrors = {
    "items.1.pointsCenti": ["Points must be more than 0."],
    "items.0.label": ["Give the item a label."],
    teacherNotes: ["Use at most 4000 characters."],
    acknowledgeAiProposed: ["Tick the box."],
  };

  it("picks one row's errors by field", () => {
    expect(rowErrors(fieldErrors, 1)).toEqual({ pointsCenti: ["Points must be more than 0."] });
    expect(rowErrors(fieldErrors, 2)).toEqual({});
  });

  it("describes errors in row order, naming rows by label", () => {
    const rows = [draft({ label: "" }), draft({ label: "3b" })];
    expect(describeErrors(fieldErrors, rows)).toEqual([
      "Item 1, label: Give the item a label.",
      "Item 3b, points: Points must be more than 0.",
      "Teacher's notes: Use at most 4000 characters.",
      "Tick the box.",
    ]);
  });
});

describe("draftsSnapshot", () => {
  it("ignores client keys but notices content, order and notes changes", () => {
    const a = draft({ key: "x" });
    const b = draft({ key: "y", id: "item-2", label: "2" });
    const base = draftsSnapshot([a, b], "");
    expect(draftsSnapshot([{ ...a, key: "z" }, b], "")).toBe(base);
    expect(draftsSnapshot([b, a], "")).not.toBe(base);
    expect(draftsSnapshot([a, { ...b, pointsText: "3" }], "")).not.toBe(base);
    expect(draftsSnapshot([a, b], "Note")).not.toBe(base);
  });
});
