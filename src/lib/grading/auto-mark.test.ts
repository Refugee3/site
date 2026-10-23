import { describe, expect, it } from "vitest";
import {
  autoMark, type AutoMarkContext, type MarkableItem, type MarkableReading, matchesExactly, normalizeAnswerText, optionLettersFromPrompt,
  parseChoiceLetters, parseQuantity, parseTrueFalse, sameNumber,
} from "./auto-mark";

const item = (o: Partial<MarkableItem> = {}): MarkableItem => ({
  answerType: "multiple_choice", expectedAnswer: "C", acceptableAnswers: [], gradingCriteria: "", prompt: "", ...o,
});
const read = (studentAnswer: string, o: Partial<MarkableReading> = {}): MarkableReading => ({
  student_answer: studentAnswer, attempt: "complete", legibility: "clear", reading_confidence: "high", ...o,
});
const ctx = (o: Partial<AutoMarkContext> = {}): AutoMarkContext => ({ hasRuling: false, teacherNotes: "", ...o });
const mark = (i: Partial<MarkableItem>, answer: string, r: Partial<MarkableReading> = {}, c: Partial<AutoMarkContext> = {}) =>
  autoMark(item(i), read(answer, r), ctx(c));

describe("the professor's case", () => {
  it("marks a B as wrong when the key says C, whatever the key's wording", () => {
    for (const expectedAnswer of ["C", "c", "(C)", "C.", "C) carbon dioxide", "C: carbon dioxide", "Answer: C"]) {
      expect(mark({ expectedAnswer }, "B"), expectedAnswer).toEqual({ correctness: "incorrect", confidence: "high", review_reason: "none", basis: "compared" });
      expect(mark({ expectedAnswer }, "C"), expectedAnswer).toMatchObject({ correctness: "correct", basis: "compared" });
    }
  });
});

describe("multiple choice", () => {
  it("reads the student's letter however it was transcribed", () => {
    for (const answer of ["C", "c", "(C)", "C)", "C.", " C ", "C) carbon dioxide"]) {
      expect(mark({}, answer), answer).toMatchObject({ correctness: "correct" });
    }
  });

  it("takes accepted answers from the acceptable list too, and 'or' as alternatives", () => {
    expect(mark({ expectedAnswer: "photosynthesis", acceptableAnswers: ["B"] }, "B")).toMatchObject({ correctness: "correct" });
    expect(mark({ expectedAnswer: "B or D" }, "D")).toMatchObject({ correctness: "correct" });
    expect(mark({ expectedAnswer: "B or D" }, "A")).toMatchObject({ correctness: "incorrect" });
  });

  it("marks several letters wrong and asks the teacher to check, unless the key expects several", () => {
    expect(mark({ expectedAnswer: "C" }, "B, C")).toEqual({ correctness: "incorrect", confidence: "high", review_reason: "multiple_answers", basis: "compared" });
    expect(mark({ expectedAnswer: "C" }, "C and D")).toMatchObject({ correctness: "incorrect", review_reason: "multiple_answers" });
    expect(mark({ expectedAnswer: "B and D" }, "D, B")).toMatchObject({ correctness: "correct", review_reason: "none" });
    expect(mark({ expectedAnswer: "B, D" }, "B")).toMatchObject({ correctness: "incorrect", review_reason: "none" });
    expect(mark({ expectedAnswer: "B & D" }, "B and C")).toMatchObject({ correctness: "incorrect", review_reason: "none" });
  });

  it("compares a written option text with the key's option text exactly, and leaves any other text to the judge", () => {
    expect(mark({ expectedAnswer: "B) photosynthesis" }, "Photosynthesis.")).toMatchObject({ correctness: "correct" });
    expect(mark({ expectedAnswer: "B) photosynthesis" }, "respiration")).toBeNull();
    expect(mark({ expectedAnswer: "photosynthesis" }, "B")).toBeNull(); // the key names no letter
  });

  it("leaves a letter that isn't one of the question's options to the judge (likely a misreading)", () => {
    expect(mark({ prompt: "Pick: A) x B) y C) z" }, "E")).toBeNull();
    expect(mark({ prompt: "Pick: A) x B) y C) z" }, "B")).toMatchObject({ correctness: "incorrect" });
  });
});

describe("true / false", () => {
  it("compares the word or letter, reading only the first word of the key", () => {
    expect(mark({ answerType: "true_false", expectedAnswer: "True" }, "T")).toMatchObject({ correctness: "correct" });
    expect(mark({ answerType: "true_false", expectedAnswer: "F" }, "false.")).toMatchObject({ correctness: "correct" });
    expect(mark({ answerType: "true_false", expectedAnswer: "False — the sun is a star" }, "True")).toMatchObject({ correctness: "incorrect" });
    expect(mark({ answerType: "true_false", expectedAnswer: "True" }, "T, F")).toMatchObject({ correctness: "incorrect", review_reason: "multiple_answers" });
  });

  it("leaves explanations, unclear keys and items with criteria to the judge", () => {
    expect(mark({ answerType: "true_false", expectedAnswer: "False" }, "False, because it is a star")).toBeNull();
    expect(mark({ answerType: "true_false", expectedAnswer: "It depends" }, "T")).toBeNull();
    expect(mark({ answerType: "true_false", expectedAnswer: "False", gradingCriteria: "Correct the statement." }, "F")).toBeNull();
  });
});

describe("numbers", () => {
  const num = (expectedAnswer: string, answer: string, o: Partial<MarkableItem> = {}) =>
    mark({ answerType: "numeric", expectedAnswer, ...o }, answer);

  it("accepts equal numbers in any form: decimals, fractions, mixed numbers, signs, thousands, x = …", () => {
    for (const [expected, answer] of [["0.5", "1/2"], ["1/2", "0.50"], ["2/4", "1/2"], ["x = 4", "4"], ["4", "x=4"], ["1 1/2", "1.5"],
      ["-3", "−3"], ["1000", "1,000"], [".25", "0.25"], ["12", "12."]]) {
      expect(num(expected, answer), `${expected} vs ${answer}`).toMatchObject({ correctness: "correct" });
    }
    expect(num("x = 4", "5", { acceptableAnswers: ["4.0"] })).toBeNull();
    expect(num("7", "8; work: 3 + 5")).toBeNull();
    expect(num("8", "8; work: 3 + 5")).toMatchObject({ correctness: "correct" });
  });

  it("never marks a different number wrong itself: it may be a slip the judge calls a minor error", () => {
    expect(num("4", "5")).toBeNull();
    expect(num("1/3", "0.33")).toBeNull();
  });

  it("checks units: the key's unit must be there, and a key without units accepts any", () => {
    expect(num("12 cm", "12 cm")).toMatchObject({ correctness: "correct" });
    expect(num("12 cm", "12cm")).toMatchObject({ correctness: "correct" });
    expect(num("9.8 m/s^2", "9.8 m/s²")).toMatchObject({ correctness: "correct" });
    expect(num("12 cm", "12")).toBeNull();
    expect(num("12 cm", "12 mm")).toBeNull();
    expect(num("12", "12 cm")).toMatchObject({ correctness: "correct" });
    expect(num("50%", "50 %")).toMatchObject({ correctness: "correct" });
  });

  it("leaves words, several numbers and items with criteria to the judge", () => {
    expect(num("4", "four")).toBeNull();
    expect(num("4", "4 or 5")).toBeNull();
    expect(num("4", "4, 5")).toBeNull();
    expect(num("4", "4", { gradingCriteria: "Must show cross-multiplication." })).toBeNull();
  });

  it("parses quantities", () => {
    expect(parseQuantity("x = 3/4")).toEqual({ value: 0.75, unit: "" });
    expect(parseQuantity("-2 1/2 kg")).toEqual({ value: -2.5, unit: "kg" });
    expect(parseQuantity("1,250.5 mL")).toEqual({ value: 1250.5, unit: "mL" });
    expect(parseQuantity("3/0")).toBeNull();
    expect(parseQuantity("about 4")).toBeNull();
    expect(parseQuantity("4 maybe")).toBeNull();
    expect(sameNumber(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameNumber(0.33, 1 / 3)).toBe(false);
  });
});

describe("short answers and fill in the blank", () => {
  it("accepts an exact match with the expected or an accepted answer, ignoring case, spaces and punctuation", () => {
    const sa = { answerType: "short_answer" as const, expectedAnswer: "carbon dioxide", acceptableAnswers: ["CO2"] };
    expect(mark(sa, "Carbon  Dioxide.")).toMatchObject({ correctness: "correct" });
    expect(mark(sa, "co2")).toMatchObject({ correctness: "correct" });
    expect(mark({ answerType: "fill_in_blank", expectedAnswer: "mitochondria; ATP" }, "mitochondria, ATP")).toMatchObject({ correctness: "correct" });
  });

  it("leaves anything else to the judge, wrong or not (synonyms, spelling, partial answers)", () => {
    expect(mark({ answerType: "short_answer", expectedAnswer: "carbon dioxide" }, "oxygen")).toBeNull();
    expect(mark({ answerType: "short_answer", expectedAnswer: "carbon dioxide" }, "carbon dioxid")).toBeNull();
    expect(mark({ answerType: "short_answer", expectedAnswer: "" }, "")).toMatchObject({ basis: "unreadable" });
    expect(mark({ answerType: "short_answer", expectedAnswer: "x", gradingCriteria: "Explain." }, "x")).toBeNull();
  });

  it("keeps signs and decimal points", () => {
    expect(normalizeAnswerText("-3")).not.toBe(normalizeAnswerText("3"));
    expect(normalizeAnswerText("3.5")).not.toBe(normalizeAnswerText("35"));
    expect(matchesExactly("Hello, world!", ["hello world"])).toBe(true);
    expect(matchesExactly("", [""])).toBe(false);
  });
});

describe("blank, unreadable and unsure readings", () => {
  it("marks a blank item no_answer for every type", () => {
    for (const answerType of ["multiple_choice", "long_answer", "diagram"] as const) {
      expect(mark({ answerType }, "", { attempt: "none", legibility: "no_writing" }))
        .toEqual({ correctness: "no_answer", confidence: "high", review_reason: "none", basis: "blank" });
    }
  });

  it("marks an illegible answer cannot_judge, and an attempt with nothing transcribed for the teacher", () => {
    expect(mark({}, "[illegible]", { legibility: "illegible" })).toMatchObject({ correctness: "cannot_judge", basis: "unreadable" });
    expect(mark({}, "[illegible]")).toMatchObject({ correctness: "cannot_judge" });
    expect(mark({}, "", { attempt: "partial" })).toEqual({ correctness: "cannot_judge", confidence: "low", review_reason: "ambiguous_reading", basis: "unreadable" });
    expect(mark({ answerType: "short_answer", expectedAnswer: "x = 4" }, "x = [illegible]", { legibility: "partly_illegible" })).toBeNull();
  });

  it("keeps a low-confidence reading's confidence and sends it to the teacher", () => {
    expect(mark({}, "B", { reading_confidence: "low" })).toEqual({ correctness: "incorrect", confidence: "low", review_reason: "ambiguous_reading", basis: "compared" });
    expect(mark({}, "C", { reading_confidence: "medium" })).toEqual({ correctness: "correct", confidence: "medium", review_reason: "none", basis: "compared" });
  });
});

describe("what the program leaves to the judge", () => {
  it("leaves items with a ruling, and subjective types, to the judge", () => {
    expect(mark({}, "B", {}, { hasRuling: true })).toBeNull();
    for (const answerType of ["long_answer", "matching", "diagram", "other"] as const) expect(mark({ answerType, expectedAnswer: "C" }, "C")).toBeNull();
  });

  it("with grading notes, still marks exact matches but leaves wrong answers to the judge", () => {
    expect(mark({}, "C", {}, { teacherNotes: "Q3: accept B or C." })).toMatchObject({ correctness: "correct" });
    expect(mark({}, "B", {}, { teacherNotes: "Q3: accept B or C." })).toBeNull();
    // A blank is still blank.
    expect(mark({}, "", { attempt: "none" }, { teacherNotes: "x" })).toMatchObject({ correctness: "no_answer" });
  });
});

describe("parsers", () => {
  it("parse choice letters", () => {
    expect(parseChoiceLetters("B")).toEqual(new Set(["B"]));
    expect(parseChoiceLetters("b) cells")).toEqual(new Set(["B"]));
    expect(parseChoiceLetters("A, c and D")).toEqual(new Set(["A", "C", "D"]));
    expect(parseChoiceLetters("BD")).toBeNull();
    expect(parseChoiceLetters("a cat")).toBeNull();
    expect(parseChoiceLetters("photosynthesis")).toBeNull();
    expect(parseChoiceLetters("")).toBeNull();
  });

  it("find the option letters a prompt lists", () => {
    expect(optionLettersFromPrompt("Which? A) x B) y C) z D) w")).toEqual(["A", "B", "C", "D"]);
    expect(optionLettersFromPrompt("Which? (a) x (b) y")).toEqual(["A", "B"]);
    expect(optionLettersFromPrompt("Which gas do plants take in?")).toBeNull();
    expect(optionLettersFromPrompt("Explain part B) of the diagram.")).toBeNull();
  });

  it("parse true and false", () => {
    expect(parseTrueFalse("TRUE")).toBe(true);
    expect(parseTrueFalse("f")).toBe(false);
    expect(parseTrueFalse("False because")).toBeNull();
    expect(parseTrueFalse("False because", { leading: true })).toBe(false);
    expect(parseTrueFalse("yes")).toBeNull();
  });
});
