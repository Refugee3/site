import { describe, expect, it } from "vitest";
import type { ChoiceReading } from "./decide";
import { keyChoiceSets, markChoice, planSpots } from "./map-key";
import { optionValue, proposalToSpots } from "./propose";
import type { QuestionSpots } from "./types";

const key = (expectedAnswer: string, acceptableAnswers: string[] = []) => ({ expectedAnswer, acceptableAnswers });
const read = (marked: string[], o: Partial<ChoiceReading> = {}): ChoiceReading => ({
  marked, confidence: "high", review: marked.length > 1 ? "multiple_answers" : "none", marksSeen: "", ...o,
});
const ctx = { hasRuling: false, teacherNotes: "" };
const box = { x: 0.1, y: 0.1, w: 0.1, h: 0.05 };

describe("keyChoiceSets", () => {
  it("maps the key's answer onto the printed options", () => {
    expect(keyChoiceSets(key("B) photosynthesis", ["B"]), ["A", "B", "C", "D"])).toEqual([new Set(["B"])]);
    expect(keyChoiceSets(key("B or D"), ["A", "B", "C", "D"])).toEqual([new Set(["B"]), new Set(["D"])]);
    expect(keyChoiceSets(key("B, D"), ["A", "B", "C", "D"])).toEqual([new Set(["B", "D"])]);
    expect(keyChoiceSets(key("F"), ["True", "False"])).toEqual([new Set(["False"])]);
    expect(keyChoiceSets(key("True — the sun is a star"), ["True", "False"])).toEqual([new Set(["True"])]);
    expect(keyChoiceSets(key("yes"), ["Yes", "No"])).toEqual([new Set(["Yes"])]);
    expect(keyChoiceSets(key("3) 12"), ["1", "2", "3", "4"])).toEqual([new Set(["3"])]);
    expect(keyChoiceSets(key("are"), ["is", "are"])).toEqual([new Set(["are"])]);
    // A letter that isn't an option, or an answer naming none: the judge compares.
    expect(keyChoiceSets(key("E"), ["A", "B", "C", "D"])).toEqual([]);
    expect(keyChoiceSets(key("photosynthesis"), ["A", "B", "C", "D"])).toEqual([]);
  });
});

describe("markChoice", () => {
  it("marks blank, right, wrong and several marks", () => {
    expect(markChoice(key("B"), ["A", "B", "C"], read([]), false, ctx)).toMatchObject({ correctness: "no_answer", basis: "blank" });
    expect(markChoice(key("B"), ["A", "B", "C"], read(["B"]), false, ctx)).toMatchObject({ correctness: "correct", review_reason: "none" });
    expect(markChoice(key("C"), ["A", "B", "C"], read(["B"]), false, ctx)).toMatchObject({ correctness: "incorrect", review_reason: "none" });
    expect(markChoice(key("B"), ["A", "B", "C"], read(["B", "C"]), false, ctx)).toMatchObject({
      correctness: "incorrect", review_reason: "multiple_answers",
    });
    // The key expects a set: the same set is right.
    expect(markChoice(key("B, C"), ["A", "B", "C"], read(["B", "C"]), true, ctx)).toMatchObject({ correctness: "correct", review_reason: "none" });
  });

  it("keeps an unsure reading's confidence and review, and leaves wrong answers to the judge under rulings or notes", () => {
    expect(markChoice(key("B"), ["A", "B"], read(["B"], { confidence: "low", review: "ambiguous_reading" }), false, ctx)).toMatchObject({
      correctness: "correct", confidence: "low", review_reason: "ambiguous_reading",
    });
    expect(markChoice(key("C"), ["A", "B", "C"], read(["B"]), false, { hasRuling: false, teacherNotes: "Accept B too" })).toBeNull();
    expect(markChoice(key("C"), ["A", "B", "C"], read(["B"]), false, { hasRuling: true, teacherNotes: "" })).toBeNull();
    expect(markChoice(key("C"), ["A", "B", "C"], read(["C"]), false, { hasRuling: true, teacherNotes: "" })).toMatchObject({ correctness: "correct" });
    expect(markChoice(key("photosynthesis"), ["A", "B"], read(["B"]), false, ctx)).toBeNull();
  });
});

describe("planSpots", () => {
  const spot = (o: Partial<QuestionSpots>): QuestionSpots => ({
    id: "s", label: "1", itemLabel: "1", kind: "choice", multi: false, enabled: true, page: 1, options: [{ value: "A", box }, { value: "B", box }],
    boxes: [], ...o,
  });

  it("uses the first enabled, linked, usable spots of each item", () => {
    const items = [{ label: "1" }, { label: "Q2" }, { label: "3" }];
    const plan = planSpots([
      spot({ id: "a", itemLabel: "1", enabled: false }),
      spot({ id: "b", itemLabel: "1" }),
      spot({ id: "c", itemLabel: "2", kind: "write_in", options: [], boxes: [box] }),
      spot({ id: "d", itemLabel: "3", options: [{ value: "A", box }] }),
      spot({ id: "e", itemLabel: null }),
    ], items);
    expect([...plan.entries()].map(([i, s]) => [i, s.id])).toEqual([[0, "b"], [1, "c"]]);
  });
});

describe("proposalToSpots", () => {
  it("turns the AI's pixel boxes into spots linked to the key", () => {
    const spots = proposalToSpots({
      questions: [
        { label: "1", kind: "choice", options: [{ label: "(a)", box: [100, 100, 140, 130] }, { label: "b)", box: [200, 100, 240, 130] }], answer_box: null },
        { label: "2", kind: "choice", options: [{ label: "T", box: [100, 200, 130, 230] }, { label: "F", box: [160, 200, 190, 230] }], answer_box: null },
        { label: "3", kind: "write_in", options: [], answer_box: [100, 300, 700, 340] },
        { label: "4", kind: "write_in", options: [], answer_box: [5, 5, 6, 6] },
      ],
    }, { page: 2, width: 1000, height: 1000, items: [{ label: "1", answerType: "multiple_choice" }, { label: "3", answerType: "diagram" }], firstId: 1 });
    expect(spots.map((s) => [s.label, s.itemLabel, s.kind, s.page, s.options.map((o) => o.value)])).toEqual([
      ["1", "1", "choice", 2, ["A", "B"]], ["2", null, "choice", 2, ["True", "False"]], ["3", "3", "diagram", 2, []],
    ]);
    const b = spots[2].boxes[0];
    expect([b.x, b.y, b.w, b.h].map((n) => Math.round(n * 1000) / 1000)).toEqual([0.1, 0.3, 0.6, 0.04]);
  });

  it("tidies option labels", () => {
    expect(["(c)", "2.", "true", "YES", "are"].map(optionValue)).toEqual(["C", "2", "True", "Yes", "are"]);
  });
});
