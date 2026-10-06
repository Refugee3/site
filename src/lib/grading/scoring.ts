import type { Attempt, Correctness, GradingMode, ItemJudgment, ItemScore, KeyItem, ScoreResult, SubmissionItem } from "@/lib/types";

// All scoring is integer centipoint math (§6). Item scores are rounded once each and then summed,
// so the items a teacher sees always add up to the total.

type Quarters = 0 | 1 | 2 | 3 | 4;

const PARTIAL_CREDIT_QUARTERS: Record<Correctness, Quarters> = {
  correct: 4,
  minor_error: 3,
  partially_correct: 2,
  major_error: 1,
  incorrect: 0,
  no_answer: 0,
  cannot_judge: 0,
};

/** Completion credit in quarters: a genuine full attempt earns everything, a partial one half. */
export function completionQuarters(a: Attempt): 0 | 2 | 4 {
  switch (a) {
    case "complete":
      return 4;
    case "partial":
      return 2;
    case "none":
      return 0;
  }
}

/** Accuracy credit in quarters; items without partial credit are all-or-nothing. */
export function accuracyQuarters(j: Pick<ItemJudgment, "attempt" | "correctness">, partialCredit: boolean): Quarters {
  if (j.attempt === "none") return 0;
  if (!partialCredit) return j.correctness === "correct" ? 4 : 0;
  return PARTIAL_CREDIT_QUARTERS[j.correctness];
}

/** num / den rounded half up, for num >= 0 and den > 0, without floating point. */
export function roundHalfUpDiv(num: number, den: number): number {
  if (num < 0 || den <= 0) throw new RangeError(`roundHalfUpDiv needs num >= 0 and den > 0 (got ${num}/${den})`);
  return Math.floor((2 * num + den) / (2 * den));
}

/** The accuracy share of the grade in percent: 0 for completion, 100 for accuracy, the weight for blended. */
function accuracyWeight(s: { gradingMode: GradingMode; accuracyWeight: number }): number {
  switch (s.gradingMode) {
    case "completion":
      return 0;
    case "accuracy":
      return 100;
    case "blended":
      return s.accuracyWeight;
  }
}

/** Points earned on one item for a judgment, with `weight` percent of the credit coming from accuracy. */
function itemCenti(pointsCenti: number, judgment: ItemJudgment, partialCredit: boolean, weight: number): number {
  const credit = (100 - weight) * completionQuarters(judgment.attempt) + weight * accuracyQuarters(judgment, partialCredit);
  return roundHalfUpDiv(pointsCenti * credit, 400);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Scores a submission against the current key items. Items without a result or judgment earn their
 * override, else 0. Completion and accuracy totals are informational and ignore every override.
 */
export function computeScore(
  items: KeyItem[],
  results: Map<string, SubmissionItem>,
  s: { gradingMode: GradingMode; accuracyWeight: number },
  totalOverrideCenti: number | null,
): ScoreResult {
  const weight = accuracyWeight(s);
  let maxCenti = 0;
  let itemsEarnedCenti = 0;
  let completionCenti = 0;
  let accuracyCenti = 0;
  let judgedCount = 0;

  const itemScores = items.map((item): ItemScore => {
    const result = results.get(item.id);
    const judgment = result?.judgment ?? null;
    const override = result?.overrideCenti ?? null;
    const computedCenti = judgment ? itemCenti(item.pointsCenti, judgment, item.partialCredit, weight) : null;
    const earnedCenti = override !== null ? clamp(override, 0, item.pointsCenti) : (computedCenti ?? 0);

    maxCenti += item.pointsCenti;
    itemsEarnedCenti += earnedCenti;
    if (judgment) {
      judgedCount++;
      completionCenti += itemCenti(item.pointsCenti, judgment, item.partialCredit, 0);
      accuracyCenti += itemCenti(item.pointsCenti, judgment, item.partialCredit, 100);
    }
    return { itemId: item.id, maxCenti: item.pointsCenti, computedCenti, earnedCenti, overridden: override !== null };
  });

  const totalOverridden = totalOverrideCenti !== null;
  const earnedCenti = totalOverridden ? clamp(totalOverrideCenti, 0, maxCenti) : itemsEarnedCenti;
  return {
    items: itemScores,
    earnedCenti,
    maxCenti,
    percentTenths: maxCenti > 0 ? roundHalfUpDiv(earnedCenti * 1000, maxCenti) : null,
    completionCenti,
    accuracyCenti,
    totalOverridden,
    judgedCount,
  };
}
