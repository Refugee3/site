import { describe, expect, it } from "vitest";
import { findAnswerMatches, normalizeAnswer } from "@/lib/grading/answer-match";
import { nameKey, nameSortKey } from "@/lib/grading/names";
import { makeJudgment, makeKeyItem, makeResult, makeSubmission } from "@/lib/grading/test-utils";
import type { KeyItem, Submission, SubmissionItem } from "@/lib/types";

const ACCURACY = { gradingMode: "accuracy", accuracyWeight: 100 } as const;
const KEY = "CBDABC";
const ITEMS: KeyItem[] = [...KEY].map((_, i) => makeKeyItem({ id: `q${i + 1}`, label: String(i + 1), position: i, answerType: "multiple_choice" }));

/** A class from answer strings ("CBDABA": one letter per question, "-" for blank), marked against KEY. */
function quiz(rows: Array<[string, string]>, o: Partial<Submission> = {}) {
  const submissions: Submission[] = [];
  const results = new Map<string, SubmissionItem[]>();
  rows.forEach(([name, answers], n) => {
    const id = `p${n + 1}`;
    submissions.push(makeSubmission({ id, studentName: name, nameKey: nameKey(name), nameSortKey: nameSortKey(name), createdAt: n + 1, ...o }));
    results.set(id, [...answers].map((letter, i) => ({
      ...makeResult(`q${i + 1}`, letter === "-"
        ? makeJudgment({ attempt: "none", correctness: "no_answer", studentAnswer: "" })
        : makeJudgment({ correctness: letter === KEY[i] ? "correct" : "incorrect", studentAnswer: letter })),
      submissionId: id,
    })));
  });
  return findAnswerMatches(ITEMS, submissions, [], results, ACCURACY);
}

const pair = (m: { a: { name: string | null }; b: { name: string | null } }) => [m.a.name, m.b.name].sort().join(" & ");

describe("findAnswerMatches", () => {
  it("flags two students with the same rare wrong answers", () => {
    const summary = quiz([
      ["Ana Diaz", "CADCBD"],
      ["Ben Lee", "CADCBD"],
      ["Cara Moss", "CBDABC"],
      ["Dev Rao", "CBDABA"],
      ["Eli Park", "ABDABC"],
      ["Fay Wong", "CBDBBC"],
    ]);
    expect(summary).toMatchObject({ papers: 6, enough: true });
    expect(summary.matches.map(pair)).toEqual(["Ana Diaz & Ben Lee"]);
    const [m] = summary.matches;
    expect(m).toMatchObject({ compared: 6, same: 6, strength: "strong" });
    expect(m.sharedWrong.map((s) => [s.label, s.answer, s.rare, s.others])).toEqual([
      ["2", "A", true, 0], ["4", "C", true, 0], ["6", "D", true, 0],
    ]);
  });

  it("never flags students for getting the same questions right", () => {
    const summary = quiz([
      ["Ana Diaz", "CBDABC"],
      ["Ben Lee", "CBDABC"],
      ["Cara Moss", "CBDABC"],
      ["Dev Rao", "CBDABA"],
      ["Eli Park", "CBDABA"],
    ]);
    expect(summary.matches).toEqual([]);
  });

  it("doesn't count a wrong answer most of the class chose as evidence", () => {
    // Everyone fell for D on question 6, and C on question 5: common mistakes, not copying.
    const summary = quiz([
      ["Ana Diaz", "CBDACD"],
      ["Ben Lee", "CBDACD"],
      ["Cara Moss", "CBDACD"],
      ["Dev Rao", "CBDACD"],
      ["Eli Park", "CBDABD"],
    ]);
    expect(summary.matches).toEqual([]);
  });

  it("calls a pair with one rare wrong answer in common only possible", () => {
    const summary = quiz([
      ["Ana Diaz", "CBDCCD"],
      ["Ben Lee", "CBDCCD"],
      ["Cara Moss", "CBDACD"],
      ["Dev Rao", "CBDACD"],
      ["Eli Park", "CBDABD"],
      ["Fay Wong", "CBDABC"],
    ]);
    expect(summary.matches.map((m) => [pair(m), m.strength])).toEqual([["Ana Diaz & Ben Lee", "possible"]]);
  });

  it("ignores blanks, and needs enough papers and answered questions", () => {
    expect(quiz([["Ana Diaz", "CADCBD"], ["Ben Lee", "CADCBD"], ["Cara Moss", "CBDABC"]])).toMatchObject({ matches: [], enough: false });
    const blanks = quiz([
      ["Ana Diaz", "-A-C--"],
      ["Ben Lee", "-A-C--"],
      ["Cara Moss", "CBDABC"],
      ["Dev Rao", "CBDABA"],
    ]);
    expect(blanks.matches).toEqual([]);
  });

  it("only compares papers that are graded or waiting for review", () => {
    const summary = quiz([
      ["Ana Diaz", "CADCBD"],
      ["Ben Lee", "CADCBD"],
      ["Cara Moss", "CBDABC"],
      ["Dev Rao", "CBDABA"],
    ], { status: "grading" });
    expect(summary).toMatchObject({ papers: 0, enough: false, matches: [] });
  });
});

describe("normalizeAnswer", () => {
  it("compares choice answers by their letter, and other answers ignoring case and spacing", () => {
    expect(["B", "b.", "(b)", "B) Not expected", " b "].map((a) => normalizeAnswer(a, "multiple_choice"))).toEqual(["b", "b", "b", "b", "b"]);
    expect(normalizeAnswer("Photo  Synthesis.", "short_answer")).toBe("photo synthesis");
    expect(normalizeAnswer("Bacteria", "multiple_choice")).toBe("bacteria");
  });
});
