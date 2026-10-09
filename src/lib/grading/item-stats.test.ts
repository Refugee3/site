import { describe, expect, it } from "vitest";
import {
  commonAnswers, computeItemStats, isHighlighted, MISS_HIGHLIGHT_MIN_PAPERS, MISS_HIGHLIGHT_MIN_TENTHS, paperOutcomes,
} from "@/lib/grading/item-stats";
import { nameKey, nameSortKey } from "@/lib/grading/names";
import { makeJudgment, makeKeyItem, makeResult, makeSection, makeSubmission } from "@/lib/grading/test-utils";
import type { Correctness, ItemJudgment, KeyItem, Submission, SubmissionItem } from "@/lib/types";

const ACCURACY = { gradingMode: "accuracy", accuracyWeight: 100 } as const;
const COMPLETION = { gradingMode: "completion", accuracyWeight: 0 } as const;

const q1 = makeKeyItem({ id: "q1", label: "1", position: 0, pointsCenti: 400 });
const q2 = makeKeyItem({ id: "q2", label: "2", position: 1, pointsCenti: 400 });
const ITEMS: KeyItem[] = [q1, q2];

function paper(id: string, name: string | null, o: Partial<Submission> = {}): Submission {
  return makeSubmission({ id, studentName: name, nameKey: nameKey(name), nameSortKey: nameSortKey(name), ...o });
}

function judged(correctness: Correctness, o: Partial<ItemJudgment> = {}): ItemJudgment {
  return makeJudgment({ correctness, attempt: correctness === "no_answer" ? "none" : "complete", ...o });
}

/** Builds papers named Student 1…n, each answering q1 and q2 as given. */
function classOf(answers: Array<[ItemJudgment | null, ItemJudgment | null]>, o: Partial<Submission> = {}) {
  const submissions: Submission[] = [];
  const results = new Map<string, SubmissionItem[]>();
  answers.forEach(([a, b], i) => {
    const id = `p${i + 1}`;
    submissions.push(paper(id, `Student ${i + 1}`, { createdAt: i + 1, ...o }));
    results.set(id, [
      ...(a ? [{ ...makeResult("q1", a), submissionId: id }] : []),
      ...(b ? [{ ...makeResult("q2", b), submissionId: id }] : []),
    ]);
  });
  return { submissions, results };
}

describe("computeItemStats", () => {
  it("counts each outcome and computes the miss rate from lost accuracy credit", () => {
    const { submissions, results } = classOf([
      [judged("correct"), judged("correct")],
      [judged("incorrect"), judged("correct")],
      [judged("no_answer"), judged("correct")],
      [judged("partially_correct"), judged("correct")],
      [judged("cannot_judge"), judged("minor_error")],
    ]);
    const stats = computeItemStats(ITEMS, submissions, [], results, ACCURACY);
    const [s1, s2] = stats.items;
    expect(s1).toMatchObject({ judged: 5, correct: 1, wrong: 1, blank: 1, partly: 1, unreadable: 1, missedPapers: 4 });
    // Earned 4 + 0 + 0 + 2 + 0 = 6 of 20 points: 30% earned, 70% missed.
    expect(s1.missedTenths).toBe(700);
    expect(s1.correctTenths).toBe(200);
    expect(s1.earnedTenths).toBe(300);
    expect(s1.highlighted).toBe(true);
    // One minor error (3/4 credit) among five: 5% missed, not highlighted.
    expect(s2).toMatchObject({ judged: 5, correct: 4, partly: 1, missedPapers: 1, missedTenths: 50, highlighted: false });
    expect(stats.highlighted.map((s) => s.item.id)).toEqual(["q1"]);
    expect(stats.countedPapers).toBe(5);
  });

  it("highlights only at the paper and miss-rate thresholds", () => {
    expect(MISS_HIGHLIGHT_MIN_PAPERS).toBe(5);
    expect(MISS_HIGHLIGHT_MIN_TENTHS).toBe(400);
    expect(isHighlighted({ judged: 5, missedTenths: 400 })).toBe(true);
    expect(isHighlighted({ judged: 5, missedTenths: 399 })).toBe(false);
    expect(isHighlighted({ judged: 4, missedTenths: 1000 })).toBe(false);
    expect(isHighlighted({ judged: 0, missedTenths: null })).toBe(false);

    // Four papers all wrong: not enough papers yet.
    const few = classOf(Array.from({ length: 4 }, () => [judged("incorrect"), judged("correct")] as [ItemJudgment, ItemJudgment]));
    expect(computeItemStats(ITEMS, few.submissions, [], few.results, ACCURACY).highlighted).toEqual([]);

    // Two of five wrong is exactly 40%.
    const atLine = classOf([
      [judged("incorrect"), judged("correct")],
      [judged("incorrect"), judged("correct")],
      [judged("correct"), judged("correct")],
      [judged("correct"), judged("correct")],
      [judged("correct"), judged("correct")],
    ]);
    const stats = computeItemStats(ITEMS, atLine.submissions, [], atLine.results, ACCURACY);
    expect(stats.items[0]).toMatchObject({ missedTenths: 400, highlighted: true });
  });

  it("counts teacher overrides, which also decide the outcome", () => {
    const { submissions, results } = classOf(Array.from({ length: 5 }, () => [judged("incorrect"), judged("correct")] as [ItemJudgment, ItemJudgment]));
    // The teacher gives full credit on two of the wrong answers and half credit on one.
    results.get("p1")![0].overrideCenti = 400;
    results.get("p2")![0].overrideCenti = 400;
    results.get("p3")![0].overrideCenti = 200;
    // And takes the credit away from a correct answer.
    results.get("p4")![1].overrideCenti = 0;
    const stats = computeItemStats(ITEMS, submissions, [], results, ACCURACY);
    // Earned 4 + 4 + 2 + 0 + 0 of 20: 50% missed.
    expect(stats.items[0]).toMatchObject({ correct: 2, partly: 1, wrong: 2, missedTenths: 500, highlighted: true });
    expect(stats.items[1]).toMatchObject({ correct: 4, wrong: 1, missedTenths: 200 });
  });

  it("counts an item with only an override as judged", () => {
    const { submissions, results } = classOf([[null, judged("correct")]]);
    results.get("p1")!.push({ ...makeResult("q1", null, 100), submissionId: "p1" });
    const [s1] = computeItemStats(ITEMS, submissions, [], results, ACCURACY).items;
    expect(s1).toMatchObject({ judged: 1, partly: 1, missedTenths: 750 });
  });

  it("ignores a whole-paper total override", () => {
    const { submissions, results } = classOf([[judged("incorrect"), judged("incorrect")]], { totalOverrideCenti: 800 });
    expect(computeItemStats(ITEMS, submissions, [], results, ACCURACY).items[0].missedTenths).toBe(1000);
  });

  it("leaves out earlier attempts and papers that aren't graded", () => {
    const submissions = [
      paper("old", "Maria Lopez", { createdAt: 1 }),
      paper("new", "Maria Lopez", { createdAt: 2 }),
      paper("queued", "Ann Queue", { createdAt: 3, status: "queued" }),
      paper("failed", "Fay Failed", { createdAt: 4, status: "failed" }),
      paper("review", "Rae Review", { createdAt: 5, status: "needs_review" }),
    ];
    const results = new Map<string, SubmissionItem[]>(
      submissions.map((s) => [s.id, [{ ...makeResult("q1", judged(s.id === "new" ? "correct" : "incorrect")), submissionId: s.id }]]),
    );
    const stats = computeItemStats(ITEMS, submissions, [], results, ACCURACY);
    // Only Maria's newest paper (correct) and the paper waiting for review (wrong) count.
    expect(stats.countedPapers).toBe(2);
    expect(stats.items[0]).toMatchObject({ judged: 2, correct: 1, wrong: 1 });
    // q2 was never judged.
    expect(stats.items[1]).toMatchObject({ judged: 0, missedTenths: null, correctTenths: null, highlighted: false });
  });

  it("still finds misses on a completion-graded assignment", () => {
    const { submissions, results } = classOf([
      [judged("incorrect"), judged("correct")],
      [judged("incorrect"), judged("correct")],
      [judged("no_answer"), judged("correct")],
      [judged("correct"), judged("correct")],
      [judged("correct"), judged("correct")],
    ]);
    const [s1] = computeItemStats(ITEMS, submissions, [], results, COMPLETION).items;
    // The wrong answers earn full completion credit, but are still missed.
    expect(s1).toMatchObject({ wrong: 2, blank: 1, missedTenths: 600, highlighted: true });
    expect(s1.earnedTenths).toBe(800);
  });

  it("counts all-or-nothing items' partly right answers as fully missed", () => {
    const item = makeKeyItem({ id: "q1", pointsCenti: 400, partialCredit: false });
    const { submissions, results } = classOf([[judged("minor_error"), null], [judged("correct"), null]]);
    expect(computeItemStats([item], submissions, [], results, ACCURACY).items[0]).toMatchObject({ partly: 1, missedTenths: 500 });
  });

  it("breaks the tally down by section when papers fall in two or more", () => {
    const period1 = makeSection({ label: "Period 1", canonicalKey: "1", sortOrder: 0 });
    const period2 = makeSection({ label: "Period 2", canonicalKey: "2", sortOrder: 1 });
    const { submissions, results } = classOf([
      [judged("incorrect"), null],
      [judged("incorrect"), null],
      [judged("correct"), null],
      [judged("correct"), null],
      [judged("correct"), null],
    ]);
    submissions.forEach((s, i) => (s.sectionId = i < 2 ? period2.id : period1.id));
    const stats = computeItemStats(ITEMS, submissions, [period1, period2], results, ACCURACY);
    expect(stats.bySection).toBe(true);
    expect(stats.items[0].sections.map((s) => [s.label, s.judged, s.missedTenths])).toEqual([
      ["Period 1", 3, 0],
      ["Period 2", 2, 1000],
    ]);

    // One section: no breakdown.
    submissions.forEach((s) => (s.sectionId = period1.id));
    const single = computeItemStats(ITEMS, submissions, [period1, period2], results, ACCURACY);
    expect(single.bySection).toBe(false);
    expect(single.items[0].sections).toEqual([]);
  });

  it("sorts highlighted items by miss rate, then key order", () => {
    const q3 = makeKeyItem({ id: "q3", label: "3", position: 2, pointsCenti: 400 });
    const submissions = Array.from({ length: 5 }, (_, i) => paper(`p${i}`, `Student ${i}`, { createdAt: i }));
    const results = new Map<string, SubmissionItem[]>(submissions.map((s, i) => [s.id, [
      { ...makeResult("q1", judged(i < 2 ? "incorrect" : "correct")), submissionId: s.id },
      { ...makeResult("q2", judged(i < 4 ? "incorrect" : "correct")), submissionId: s.id },
      { ...makeResult("q3", judged(i < 2 ? "incorrect" : "correct")), submissionId: s.id },
    ]]));
    const stats = computeItemStats([q1, q2, q3], submissions, [], results, ACCURACY);
    expect(stats.highlighted.map((s) => s.item.id)).toEqual(["q2", "q1", "q3"]);
  });
});

describe("paperOutcomes", () => {
  it("returns the student's answer and null for unjudged items", () => {
    const outcomes = paperOutcomes(ITEMS, [makeResult("q1", judged("incorrect", { studentAnswer: "x = 5" }))], ACCURACY, null);
    expect(outcomes[0]).toMatchObject({ outcome: "wrong", studentAnswer: "x = 5", accuracyCenti: 0, maxCenti: 400 });
    expect(outcomes[1]).toBeNull();
  });

  it("calls an override of zero on a blank answer blank", () => {
    const [outcome] = paperOutcomes(ITEMS, [makeResult("q1", judged("no_answer"), 0)], ACCURACY, null);
    expect(outcome?.outcome).toBe("blank");
  });
});

describe("commonAnswers", () => {
  it("groups answers ignoring case and spacing and keeps those written twice or more", () => {
    expect(commonAnswers(["x = 5", "X  =  5", " x = 5", "12", "12", "", "7"])).toEqual([
      { answer: "x = 5", count: 3 },
      { answer: "12", count: 2 },
    ]);
    expect(commonAnswers(["a", "a", "b", "b", "c", "c", "d", "d"], 2)).toHaveLength(2);
  });
});
