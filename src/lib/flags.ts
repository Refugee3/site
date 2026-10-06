import type { FlagCode } from "@/lib/types";

export interface FlagDef {
  severity: "review" | "info";
  label: string;
  description: string;
}

export const FLAG_DEFS: Record<FlagCode, FlagDef> = {
  name_missing: {
    severity: "review",
    label: "No name found",
    description: "The AI could not find a student name on the paper; enter it in the identity form.",
  },
  name_unclear: {
    severity: "review",
    label: "Name hard to read",
    description: "The AI read a name but is not confident in the reading; check it against page 1.",
  },
  name_uncertain: {
    severity: "info",
    label: "Name possibly misread",
    description: "The AI is only moderately sure of the name it read; a quick glance at page 1 confirms it.",
  },
  section_unmatched: {
    severity: "review",
    label: "Section not matched",
    description: "The section written on the paper is missing or matches none of your sections; pick one in the identity form.",
  },
  section_inferred: {
    severity: "info",
    label: "Section inferred",
    description: "The section was matched loosely (by number, the AI's suggestion, or because only one section exists) rather than exactly.",
  },
  multiple_students: {
    severity: "review",
    label: "Several students",
    description: "The pages appear to contain more than one student's work.",
  },
  wrong_assignment: {
    severity: "review",
    label: "Possibly wrong assignment",
    description: "The paper may not be an attempt at this assignment, or may not be student work at all.",
  },
  blank_submission: {
    severity: "review",
    label: "Blank paper",
    description: "The AI found no attempted answers on this paper.",
  },
  pages_missing: {
    severity: "review",
    label: "Pages may be missing",
    description: "The work stops in a way that suggests some pages were not included in the upload.",
  },
  low_confidence: {
    severity: "review",
    label: "Low-confidence item",
    description: "At least one item was read or judged with low confidence; check those items before trusting the score.",
  },
  illegible: {
    severity: "review",
    label: "Illegible work",
    description: "At least one answer could not be read well enough to judge; it earns no accuracy credit until you override it.",
  },
  item_review: {
    severity: "review",
    label: "Item needs a decision",
    description: "The AI asked you to decide at least one item, for example an alternate answer or a possibly wrong key.",
  },
  grader_directed_text: {
    severity: "review",
    label: "Text aimed at the grader",
    description: "The paper contains text addressed to the AI or grader; it was ignored, but the paper deserves a closer look.",
  },
  output_repaired: {
    severity: "review",
    label: "AI output repaired",
    description: "The AI's answer was inconsistent or incomplete and was corrected automatically; check the affected items.",
  },
  ai_refused: {
    severity: "review",
    label: "AI declined",
    description: "The AI declined to grade this paper; enter points with overrides or regrade it.",
  },
  manual_grading: {
    severity: "review",
    label: "Graded manually",
    description: "Automatic grading failed, so this paper is waiting for you to enter points with overrides.",
  },
  fallback_model: {
    severity: "info",
    label: "Fallback model",
    description: "This paper was graded by a fallback model because the primary model was unavailable.",
  },
};

export const IDENTITY_FLAGS: ReadonlySet<FlagCode> = new Set<FlagCode>([
  "name_missing", "name_unclear", "name_uncertain", "section_unmatched", "section_inferred",
]);

export function hasReviewFlag(flags: FlagCode[]): boolean {
  return flags.some((flag) => FLAG_DEFS[flag].severity === "review");
}

/** Status of a graded paper after its flags change: a teacher's review sticks, otherwise review flags decide. */
export function statusFromFlags(flags: FlagCode[], reviewedAt: number | null): "graded" | "needs_review" {
  if (reviewedAt !== null) return "graded";
  return hasReviewFlag(flags) ? "needs_review" : "graded";
}
