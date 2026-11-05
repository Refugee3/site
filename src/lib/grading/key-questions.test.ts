import { describe, expect, it } from "vitest";
import type { KeyExtraction } from "@/lib/ai/schemas";
import {
  applyKeyAnswers, appendNotes, findItemIndex, isPlaceholderTitle, isYes, LIMITS, normalizeExtractedQuestions, normalizeLabel,
  normalizeSuggestedTitle, NOTES_HEADING, parsePointsAnswer, placeholderTitle,
} from "@/lib/grading/key-questions";
import { makeKeyItem } from "@/lib/grading/test-utils";
import type { KeyItem, KeyQuestion } from "@/lib/types";

function items(...labels: Array<string | [label: string, group: string]>): KeyItem[] {
  return labels.map((entry, position) => {
    const [label, groupLabel] = typeof entry === "string" ? [entry, ""] : entry;
    return makeKeyItem({ id: `i${position}`, position, label, groupLabel, pointsCenti: 100 });
  });
}

/** The parsed points as { label: points } for readable expectations. */
function points(answer: string, key: KeyItem[], target: string | null = null): Record<string, number> | null {
  const parsed = parsePointsAnswer(answer, key, target);
  if (!parsed) return null;
  return Object.fromEntries([...parsed].sort(([a], [b]) => a - b).map(([index, centi]) => [key[index].label, centi / 100]));
}

const FIVE = items("1", "2", "3", "4", "5");

describe("parsePointsAnswer", () => {
  it.each([
    ["2", 2],
    ["2 each", 2],
    ["2 points", 2],
    ["2 pts each", 2],
    ["1.5 points apiece", 1.5],
    ["all 3", 3],
    ["each is worth 2", 2],
    ["Two each.", 2],
    ["2 per question", 2],
    ["2 for all", 2],
  ])("reads %j as the same value for every item", (answer, value) => {
    expect(points(answer, FIVE)).toEqual({ 1: value, 2: value, 3: value, 4: value, 5: value });
  });

  it("reads per-question values and ranges", () => {
    const key = items("1", "2", "3", "4", "5", "6");
    expect(points("Q1-5: 1, Q6: 3", key)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 3 });
    expect(points("1–5 = 1 pt; 6 = 3 pts", key)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 3 });
    expect(points("questions 1 to 5 are worth 1 and question 6 is worth 3", key)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 3 });
    expect(points("Q6: 3", key)).toEqual({ 6: 3 });
    expect(points("3 for Q6", key)).toEqual({ 6: 3 });
  });

  it("lets labeled values win over a default, whatever the order", () => {
    const key = items("1", "2", "3", "4", "5", "6");
    expect(points("1 point each except question 6 which is 3", key)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 3 });
    expect(points("Q6: 3, the rest: 1", key)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 3 });
    expect(points("6 is 3 and all others 2", key)).toEqual({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 3 });
  });

  it("matches parts, letter ranges and whole questions with parts", () => {
    const key = items("1", ["2a", "2"], ["2b", "2"], ["2c", "2"], "3");
    expect(points("2b: 4", key)).toEqual({ "2b": 4 });
    expect(points("2a-2b: 2", key)).toEqual({ "2a": 2, "2b": 2 });
    expect(points("1-2: 2", key)).toEqual({ 1: 2, "2a": 2, "2b": 2, "2c": 2 });
    // "Q2: 3" for a question that only exists as parts: its 3 points are shared, the remainder to the last part.
    expect(points("Q2: 3", items(["2a", "2"], ["2b", "2"]))).toEqual({ "2a": 1.5, "2b": 1.5 });
    expect(points("Q2: 1", items(["2a", "2"], ["2b", "2"], ["2c", "2"]))).toEqual({ "2a": 0.33, "2b": 0.33, "2c": 0.34 });
  });

  it("applies a bare value only to the item the question was about", () => {
    expect(points("4", FIVE, "3")).toEqual({ 3: 4 });
    expect(points("4", FIVE, "Q3")).toEqual({ 3: 4 });
    // An unknown target falls back to every item.
    expect(points("4", FIVE, "9")).toEqual({ 1: 4, 2: 4, 3: 4, 4: 4, 5: 4 });
  });

  it.each([
    "",
    "it depends",
    "Q9: 2", // no question 9
    "0", // below the minimum
    "100000 each", // above the maximum
    "2 each, 3 each", // two defaults
    "Q1: lots",
    "half credit for work",
  ])("returns null for %j", (answer) => {
    expect(parsePointsAnswer(answer, FIVE)).toBeNull();
  });

  it("returns null for an empty key", () => {
    expect(parsePointsAnswer("2", [])).toBeNull();
  });
});

describe("labels", () => {
  it.each([
    ["Q4b", "4b"], ["question 4b", "4b"], ["#4B", "4b"], ["No. 12", "12"], [" 4. ", "4"], ["4)", "4"], ["IV.2", "iv.2"], ["Bonus", "bonus"],
  ])("normalizes %j to %j", (label, normalized) => {
    expect(normalizeLabel(label)).toBe(normalized);
  });

  it("finds an item by its label", () => {
    expect(findItemIndex(FIVE, "Q3")).toBe(2);
    expect(findItemIndex(FIVE, "7")).toBe(-1);
    expect(findItemIndex(FIVE, null)).toBe(-1);
    expect(findItemIndex(FIVE, "  ")).toBe(-1);
  });
});

describe("isYes", () => {
  it.each(["Yes", "yes, accept both", "Y", "Sure", "OK", "of course"])("reads %j as yes", (answer) => expect(isYes(answer)).toBe(true));
  it.each(["No", "nope", "only the exact form", "", "maybe"])("reads %j as not yes", (answer) => expect(isYes(answer)).toBe(false));
});

function question(o: Partial<KeyQuestion> & Pick<KeyQuestion, "kind">): Pick<KeyQuestion, "kind" | "itemLabel" | "question" | "answer"> {
  return { itemLabel: null, question: "A question?", answer: null, ...o };
}

describe("applyKeyAnswers", () => {
  const key = [
    makeKeyItem({ id: "a", position: 0, label: "1", expectedAnswer: "B", answerSource: "key", pointsCenti: 100 }),
    makeKeyItem({ id: "b", position: 1, label: "2", expectedAnswer: "", answerSource: "ai_proposed", pointsCenti: 100 }),
    makeKeyItem({ id: "c", position: 2, label: "3", expectedAnswer: "carbon dioxide", gradingCriteria: "Spelling counts.", pointsCenti: 100 }),
  ];

  it("fills a missing answer as the teacher's own", () => {
    const applied = applyKeyAnswers({
      items: key, teacherNotes: "",
      questions: [question({ kind: "missing_answer", itemLabel: "Q2", question: "What is the answer to 2?", answer: "  x = 4 " })],
    });
    expect(applied.items[1]).toMatchObject({ id: "b", expectedAnswer: "x = 4", answerSource: "teacher" });
    expect(applied.items[0]).toMatchObject({ expectedAnswer: "B", answerSource: "key" });
    expect(applied.changedItemIds).toEqual(["b"]);
    expect(applied.notes).toEqual([]);
    expect(applied.teacherNotes).toBe("");
  });

  it("sets points it can read and notes the ones it can't", () => {
    const readable = applyKeyAnswers({
      items: key, teacherNotes: "Units required.",
      questions: [question({ kind: "points", question: "How many points each?", answer: "2 each, Q3: 4" })],
    });
    expect(readable.items.map((item) => item.pointsCenti)).toEqual([200, 200, 400]);
    expect(readable.changedItemIds).toEqual(["a", "b", "c"]);
    expect(readable.teacherNotes).toBe("Units required.");

    const unreadable = applyKeyAnswers({
      items: key, teacherNotes: "Units required.",
      questions: [question({ kind: "points", question: "How many points each?", answer: "the usual" })],
    });
    expect(unreadable.items.map((item) => item.pointsCenti)).toEqual([100, 100, 100]);
    expect(unreadable.changedItemIds).toEqual([]);
    expect(unreadable.teacherNotes).toBe(`Units required.\n\n${NOTES_HEADING}\n- How many points each? Answer: the usual`);
  });

  it("notes equivalents and adds a criteria line for a yes about an item", () => {
    const applied = applyKeyAnswers({
      items: key, teacherNotes: "",
      questions: [
        question({ kind: "accept_equivalents", itemLabel: "3", question: "Accept CO2 for 3?", answer: "Yes" }),
        question({ kind: "accept_equivalents", itemLabel: "1", question: "Accept lowercase b for 1?", answer: "No" }),
      ],
    });
    expect(applied.items[2].gradingCriteria).toBe("Spelling counts. Accept equivalent forms (the teacher said yes when asked).");
    expect(applied.items[0].gradingCriteria).toBe("");
    expect(applied.changedItemIds).toEqual(["c"]);
    expect(applied.teacherNotes).toBe(`${NOTES_HEADING}\n- Accept CO2 for 3? Answer: Yes\n- Accept lowercase b for 1? Answer: No`);
  });

  it("notes partial credit, ambiguous items, other answers and answers about items the key lacks", () => {
    const applied = applyKeyAnswers({
      items: key, teacherNotes: "",
      questions: [
        question({ kind: "partial_credit", question: "Partial credit\nfor work?", answer: "Half for correct setup" }),
        question({ kind: "ambiguous_item", itemLabel: "2", question: "Which reading of 2?", answer: "The first" }),
        question({ kind: "other", question: "Anything else?", answer: "Ignore doodles" }),
        question({ kind: "missing_answer", itemLabel: "9", question: "Answer to 9?", answer: "42" }),
        question({ kind: "other", question: "Skipped?", answer: null }),
        question({ kind: "other", question: "Blank?", answer: "   " }),
      ],
    });
    expect(applied.changedItemIds).toEqual([]);
    expect(applied.notes).toEqual([
      "Partial credit for work? Answer: Half for correct setup",
      "Which reading of 2? Answer: The first",
      "Anything else? Answer: Ignore doodles",
      "Answer to 9? Answer: 42",
    ]);
  });

  it("never changes the items it was given", () => {
    const before = JSON.stringify(key);
    applyKeyAnswers({ items: key, teacherNotes: "", questions: [question({ kind: "points", answer: "3" })] });
    expect(JSON.stringify(key)).toBe(before);
  });
});

describe("appendNotes", () => {
  it("adds the heading once and keeps the notes within their limit", () => {
    const once = appendNotes("", ["A"]);
    expect(appendNotes(once, ["B"])).toBe(`${NOTES_HEADING}\n- A\n- B`);
    expect(appendNotes("Keep", [])).toBe("Keep");
    expect(Array.from(appendNotes("x".repeat(3990), ["a long line"])).length).toBe(LIMITS.teacherNotes);
  });
});

describe("extracted questions and titles", () => {
  const raw = (o: Partial<KeyExtraction["questions_for_teacher"][number]>): KeyExtraction["questions_for_teacher"][number] => ({
    id: "q1", kind: "other", item_label: null, question: "Q?", suggested_answer: null, choices: [], ...o,
  });

  it("tidies the AI's questions and drops empty and repeated ones", () => {
    const out = normalizeExtractedQuestions({
      questions_for_teacher: [
        raw({ kind: "missing_answer", item_label: " 4 ", question: "  What should 4 show? ", suggested_answer: " A cell ", choices: [" Yes", "Yes", ""] }),
        raw({ question: "   " }),
        raw({ question: "what should 4 show?" }),
        raw({ item_label: "", suggested_answer: "" }),
      ],
    });
    expect(out).toEqual([
      { kind: "missing_answer", itemLabel: "4", question: "What should 4 show?", suggestedAnswer: "A cell", choices: ["Yes"] },
      { kind: "other", itemLabel: null, question: "Q?", suggestedAnswer: null, choices: [] },
    ]);
  });

  it("keeps at most LIMITS.questions questions", () => {
    const many = Array.from({ length: 12 }, (_, i) => raw({ question: `Question ${i}?` }));
    expect(normalizeExtractedQuestions({ questions_for_teacher: many })).toHaveLength(LIMITS.questions);
  });

  it("tidies the suggested title", () => {
    expect(normalizeSuggestedTitle({ suggested_title: '  "Unit 4\n Quiz"  ' })).toBe("Unit 4 Quiz");
    expect(normalizeSuggestedTitle({ suggested_title: "   " })).toBeNull();
    expect(normalizeSuggestedTitle({ suggested_title: null })).toBeNull();
    expect(normalizeSuggestedTitle({ suggested_title: "x".repeat(300) })).toHaveLength(LIMITS.title);
  });

  it("knows its placeholder titles", () => {
    expect(placeholderTitle("quiz")).toBe("Untitled quiz");
    expect(isPlaceholderTitle(" Untitled homework ")).toBe(true);
    expect(isPlaceholderTitle("Untitled homework 2")).toBe(false);
  });
});
