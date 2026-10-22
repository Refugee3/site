import type { ItemJudgment } from "@/lib/types";

/**
 * Who decided an item, for the review page: the program (compared in code with the key after the paper was read without
 * it) or the AI (judged from what it read), and whether the item was read by mark detection from the blank worksheet's
 * answer spot. null for gradings stored before this was recorded.
 */
export function judgmentSourceText(j: Pick<ItemJudgment, "judgedBy" | "correctness" | "spot">): string | null {
  if (j.spot) return spotSourceText(j);
  switch (j.judgedBy) {
    case "program":
      switch (j.correctness) {
        case "no_answer":
          return "Marked by the program (left blank)";
        case "cannot_judge":
          return "Marked by the program (couldn't be read)";
        case "correct":
          return "Marked by the program (exact match)";
        default:
          return "Marked by the program (doesn't match the key)";
      }
    case "ai":
      return "Judged by the AI";
    default:
      return null;
  }
}

function spotSourceText(j: Pick<ItemJudgment, "judgedBy" | "correctness" | "spot">): string {
  const choice = j.spot?.kind === "choice";
  if (j.judgedBy === "program") {
    if (j.correctness === "no_answer") return choice ? "Marked by mark detection (nothing marked)" : "Marked by mark detection (answer spot empty)";
    if (choice) return j.correctness === "correct" ? "Marked by mark detection (matches the key)" : "Marked by mark detection (doesn't match the key)";
    return "Read from the answer spot's crop; marked by the program";
  }
  return choice ? "Read by mark detection; judged by the AI" : "Read from the answer spot's crop; judged by the AI";
}
