import type { ItemJudgment } from "@/lib/types";

/**
 * Who decided an item, for the review page: the program (compared in code with the key after the paper was read without
 * it) or the AI (judged from what it read). null for gradings stored before this was recorded.
 */
export function judgmentSourceText(j: Pick<ItemJudgment, "judgedBy" | "correctness">): string | null {
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
