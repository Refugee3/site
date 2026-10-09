import { organizeBoard, type BoardGroup } from "@/lib/grading/board";
import { computeScore, percentTenths } from "@/lib/grading/scoring";
import type { GradingMode, ItemJudgment, ItemOutcome, KeyItem, Section, Submission, SubmissionItem, SubmissionStatus } from "@/lib/types";

export type { ItemOutcome };

// How the class did on each key item, from the stored per-item judgments and the teacher's overrides. No AI calls.
//
// missRate: 1 − the average share of the item's points earned under accuracy scoring, with item overrides counted.
// Accuracy scoring is used whatever the assignment's grading mode, so a blank or wrong answer counts as missed even
// on a completion-graded assignment: the question is whether students got it right, not whether they get the points.
// A partly right answer counts as missed by the credit it lost (a minor error on a partial-credit item is 1/4 missed),
// and an answer the AI could not judge earns nothing until the teacher overrides it, as in the grades.

/** An item is highlighted once at least this many current papers were judged on it… */
export const MISS_HIGHLIGHT_MIN_PAPERS = 5;
/** …and its miss rate is at least this many tenths of a percent (400 = 40%). */
export const MISS_HIGHLIGHT_MIN_TENTHS = 400;

/** Papers that count: graded, or graded and waiting for the teacher's review. */
const COUNTED_STATUSES: readonly SubmissionStatus[] = ["graded", "needs_review"];

const ACCURACY_ONLY = { gradingMode: "accuracy", accuracyWeight: 100 } as const;

export interface ItemTally {
  /** Current graded papers with a judgment or an override on the item. */
  judged: number;
  correct: number;
  partly: number;
  wrong: number;
  blank: number;
  unreadable: number;
  /** Papers that did not get full accuracy credit (every outcome but `correct`). */
  missedPapers: number;
  /** Sum over the judged papers of the points earned under the assignment's own scoring (overrides counted). */
  earnedCenti: number;
  /** judged × the item's points. */
  maxCenti: number;
  /** Average share of the points earned under the assignment's scoring, in tenths of a percent; null when none judged. */
  earnedTenths: number | null;
  /** Share of judged papers that were fully correct, in tenths of a percent; null when none judged. */
  correctTenths: number | null;
  /** 1 − average accuracy credit (see the top of this file), in tenths of a percent; null when none judged. */
  missedTenths: number | null;
}

export interface SectionItemStats extends ItemTally {
  key: string;
  label: string;
}

export interface ItemStats extends ItemTally {
  item: Pick<KeyItem, "id" | "label" | "groupLabel" | "prompt" | "position" | "pointsCenti">;
  /** At least MISS_HIGHLIGHT_MIN_PAPERS judged and missed by at least MISS_HIGHLIGHT_MIN_TENTHS. */
  highlighted: boolean;
  /** The same tally per board section, in board order; empty unless the counted papers fall in two or more sections. */
  sections: SectionItemStats[];
}

export interface ItemStatsSummary {
  /** Every key item, in key order. */
  items: ItemStats[];
  /** The highlighted items, most missed first (then key order). */
  highlighted: ItemStats[];
  /** Current papers that are graded or need review. */
  countedPapers: number;
  /** The counted papers fall in two or more board sections, so `sections` is filled in. */
  bySection: boolean;
}

/**
 * Per-item stats over the assignment's current papers (each student's newest attempt, as the board shows them) that
 * are graded or need review. `resultsBySubmission` holds each paper's stored item results.
 */
export function computeItemStats(
  items: KeyItem[],
  submissions: Submission[],
  sections: Section[],
  resultsBySubmission: Map<string, SubmissionItem[]>,
  scoring: { gradingMode: GradingMode; accuracyWeight: number },
): ItemStatsSummary {
  const groups = countedGroups(organizeBoard(submissions, sections));
  const bySection = groups.length >= 2;
  const totals = items.map(() => emptyCounts());
  const perSection = items.map(() => groups.map(() => emptyCounts()));

  groups.forEach((group, g) => {
    for (const paper of group.papers) {
      const outcomes = paperOutcomes(items, resultsBySubmission.get(paper.id) ?? [], scoring, paper.totalOverrideCenti);
      outcomes.forEach((outcome, i) => {
        if (!outcome) return;
        addOutcome(totals[i], outcome);
        addOutcome(perSection[i][g], outcome);
      });
    }
  });

  const stats = items.map((item, i): ItemStats => {
    const tally = toTally(totals[i]);
    return {
      item: { id: item.id, label: item.label, groupLabel: item.groupLabel, prompt: item.prompt, position: item.position, pointsCenti: item.pointsCenti },
      ...tally,
      highlighted: isHighlighted(tally),
      sections: bySection ? groups.map((group, g) => ({ key: group.key, label: group.label, ...toTally(perSection[i][g]) })) : [],
    };
  });

  return {
    items: stats,
    highlighted: stats.filter((s) => s.highlighted).sort((a, b) => (b.missedTenths ?? 0) - (a.missedTenths ?? 0) || a.item.position - b.item.position),
    countedPapers: groups.reduce((sum, group) => sum + group.papers.length, 0),
    bySection,
  };
}

export function isHighlighted(t: Pick<ItemTally, "judged" | "missedTenths">): boolean {
  return t.judged >= MISS_HIGHLIGHT_MIN_PAPERS && t.missedTenths !== null && t.missedTenths >= MISS_HIGHLIGHT_MIN_TENTHS;
}

export function isCountedStatus(status: SubmissionStatus): boolean {
  return COUNTED_STATUSES.includes(status);
}

/** One paper's result on one item, or null when it has neither a judgment nor an override for it. */
export interface PaperItemOutcome {
  outcome: ItemOutcome;
  /** Points earned under the assignment's scoring (overrides counted). */
  earnedCenti: number;
  /** Points earned under accuracy scoring (overrides counted). */
  accuracyCenti: number;
  maxCenti: number;
  /** What the student wrote, as the AI transcribed it ("" without a judgment). */
  studentAnswer: string;
}

/** Each key item's outcome on one paper (null where it was not judged), in key order. */
export function paperOutcomes(
  items: KeyItem[],
  results: SubmissionItem[],
  scoring: { gradingMode: GradingMode; accuracyWeight: number },
  totalOverrideCenti: number | null,
): Array<PaperItemOutcome | null> {
  const byItem = new Map(results.map((result) => [result.itemId, result]));
  const actual = computeScore(items, byItem, scoring, totalOverrideCenti);
  const accuracy = computeScore(items, byItem, ACCURACY_ONLY, totalOverrideCenti);
  return items.map((item, i) => {
    const result = byItem.get(item.id);
    const judgment = result?.judgment ?? null;
    if (!judgment && (result?.overrideCenti ?? null) === null) return null;
    const score = accuracy.items[i];
    return {
      outcome: classify(judgment, score.overridden ? score.earnedCenti : null, score.maxCenti),
      earnedCenti: actual.items[i].earnedCenti,
      accuracyCenti: score.earnedCenti,
      maxCenti: score.maxCenti,
      studentAnswer: judgment?.studentAnswer ?? "",
    };
  });
}

/**
 * An override decides by the points it gives (full: correct; none: blank if nothing was written, else wrong; else
 * partly right); otherwise the judgment does.
 */
function classify(judgment: ItemJudgment | null, overrideCenti: number | null, maxCenti: number): ItemOutcome {
  const blank = judgment !== null && (judgment.attempt === "none" || judgment.correctness === "no_answer");
  if (overrideCenti !== null) {
    if (overrideCenti >= maxCenti) return "correct";
    if (overrideCenti <= 0) return blank ? "blank" : "wrong";
    return "partly";
  }
  if (!judgment) return "wrong";
  if (blank) return "blank";
  switch (judgment.correctness) {
    case "correct":
      return "correct";
    case "incorrect":
      return "wrong";
    case "cannot_judge":
      return "unreadable";
    default:
      return "partly";
  }
}

/**
 * The answers written most often, compared ignoring case and spacing, each with how many papers wrote it; only answers
 * written at least twice, most common first (ties: the first seen), at most `limit`. Shows the class's common mistakes.
 */
export function commonAnswers(answers: string[], limit = 3): Array<{ answer: string; count: number }> {
  const byKey = new Map<string, { answer: string; count: number }>();
  for (const raw of answers) {
    const answer = raw.trim().replace(/\s+/g, " ");
    if (answer === "") continue;
    const key = answer.toLowerCase();
    const entry = byKey.get(key);
    if (entry) entry.count++;
    else byKey.set(key, { answer, count: 1 });
  }
  return [...byKey.values()].filter((entry) => entry.count >= 2).sort((a, b) => b.count - a.count).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------

interface Counts {
  judged: number;
  correct: number;
  partly: number;
  wrong: number;
  blank: number;
  unreadable: number;
  earnedCenti: number;
  accuracyCenti: number;
  maxCenti: number;
}

function emptyCounts(): Counts {
  return { judged: 0, correct: 0, partly: 0, wrong: 0, blank: 0, unreadable: 0, earnedCenti: 0, accuracyCenti: 0, maxCenti: 0 };
}

function addOutcome(c: Counts, o: PaperItemOutcome): void {
  c.judged++;
  c[o.outcome]++;
  c.earnedCenti += o.earnedCenti;
  c.accuracyCenti += o.accuracyCenti;
  c.maxCenti += o.maxCenti;
}

function toTally(c: Counts): ItemTally {
  return {
    judged: c.judged,
    correct: c.correct,
    partly: c.partly,
    wrong: c.wrong,
    blank: c.blank,
    unreadable: c.unreadable,
    missedPapers: c.judged - c.correct,
    earnedCenti: c.earnedCenti,
    maxCenti: c.maxCenti,
    earnedTenths: percentTenths(c.earnedCenti, c.maxCenti),
    correctTenths: percentTenths(c.correct, c.judged),
    missedTenths: percentTenths(c.maxCenti - c.accuracyCenti, c.maxCenti),
  };
}

/** The board's sections with only their current papers that count; sections left empty are dropped. */
function countedGroups(groups: BoardGroup[]): Array<{ key: string; label: string; papers: Submission[] }> {
  return groups
    .map((group) => ({ key: group.key, label: group.label, papers: group.rows.map((row) => row.current).filter((s) => isCountedStatus(s.status)) }))
    .filter((group) => group.papers.length > 0);
}
