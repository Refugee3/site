import { AiError } from "@/lib/ai/errors";
import type { GradingOutput } from "@/lib/ai/schemas";
import type { GradingWrite } from "@/lib/db/repos/submissions";
import { statusFromFlags } from "@/lib/flags";
import { cleanName, nameKey, nameSortKey } from "@/lib/grading/names";
import { canonicalSectionKey, resolveSection, type SectionMatch } from "@/lib/grading/sections";
import { truncateChars } from "@/lib/grading/text";
import { FLAG_CODES, type FlagCode, type ItemJudgment, type KeyItem, type Section, type Submission } from "@/lib/types";

export interface ReconcileInput {
  output: GradingOutput;
  refs: string[];
  items: KeyItem[];
  sections: Section[];
  pageCount: number;
  current: Pick<Submission, "studentName" | "nameSource" | "nameKey" | "nameSortKey" | "sectionId" | "sectionSource">;
  fallbackUsed: boolean;
}

export interface Reconciled {
  items: Array<{ itemId: string; judgment: ItemJudgment | null }>;
  repairs: string[];
  fields: Omit<GradingWrite["fields"], "status" | "aiModel" | "usage" | "aiOutputJson" | "overallFeedback"> & { overallFeedback: string };
  status: "graded" | "needs_review";
}

type OutputItem = GradingOutput["items"][number];
type IdentityFields = Pick<Reconciled["fields"], "aiName" | "aiNameConfidence" | "aiSectionRaw" | "aiSectionMatch" | "sectionKey"
  | "studentName" | "nameSource" | "nameKey" | "nameSortKey" | "sectionId" | "sectionSource">;

// Silent caps on AI text, in characters; truncation is not recorded as a repair.
const CAPS = {
  studentAnswer: 2000,
  itemNote: 1000,
  overallFeedback: 2000,
  teacherSummary: 2000,
  name: 120,
  section: 60,
  excerpt: 300,
  documentNote: 500,
  repairs: 1000,
  unmatchedWork: 2000,
} as const;

const WRONG_ASSIGNMENT_MATCHES: ReadonlySet<GradingOutput["document_check"]["match"]> = new Set([
  "different_assignment", "not_student_work", "uncertain",
]);

/**
 * Turns one grading response into the rows and fields to store: matches judgments to key
 * items, repairs inconsistent judgments, resolves identity without overwriting the teacher's
 * edits, and computes flags and status. Throws a retryable `invalid_output` when most items are missing.
 */
export function reconcileGrading(i: ReconcileInput): Reconciled {
  const repairs: string[] = [];
  const matched = matchItems(i, repairs);
  const items = i.items.map((item, index) => {
    const output = matched[index];
    if (!output) return { itemId: item.id, judgment: null };
    return { itemId: item.id, judgment: toJudgment(output, item.label, i.pageCount, repairs) };
  });

  const { output } = i;
  const identity = resolveIdentity(i);
  const judgments = items.map((item) => item.judgment).filter((judgment) => judgment !== null);
  const flags = sortFlags([
    ...identityFlags(identity.fields, identity.sectionMatch, i.sections.length > 0),
    ...judgmentFlags(judgments),
    ...(output.student.multiple_students_detected ? ["multiple_students" as const] : []),
    ...(WRONG_ASSIGNMENT_MATCHES.has(output.document_check.match) ? ["wrong_assignment" as const] : []),
    ...(output.document_check.match === "blank" ? ["blank_submission" as const] : []),
    ...(output.document_check.pages_appear_missing ? ["pages_missing" as const] : []),
    ...(output.integrity.grader_directed_text_found ? ["grader_directed_text" as const] : []),
    ...(repairs.length > 0 ? ["output_repaired" as const] : []),
    ...(i.fallbackUsed ? ["fallback_model" as const] : []),
  ]);

  return {
    items,
    repairs,
    fields: {
      ...identity.fields,
      documentMatch: output.document_check.match,
      flags,
      // The repairs go into the teacher's notes, so the output_repaired flag points at something concrete.
      teacherSummary: joinLines(
        cap(output.teacher_summary, CAPS.teacherSummary),
        cap(output.document_check.note, CAPS.documentNote),
        repairs.length > 0 ? cap(`Automatic corrections: ${repairs.join("; ")}.`, CAPS.repairs) : "",
      ),
      integrityNote: output.integrity.grader_directed_text_found ? cap(output.integrity.excerpt, CAPS.excerpt) : "",
      unmatchedWork: cap(output.unmatched_work, CAPS.unmatchedWork),
      overallFeedback: cap(output.overall_feedback, CAPS.overallFeedback),
    },
    status: statusFromFlags(flags, null),
  };
}

/** The AI's entry for each key item (by index), or undefined when it returned none. */
function matchItems(i: ReconcileInput, repairs: string[]): Array<OutputItem | undefined> {
  const indexByRef = new Map(i.refs.slice(0, i.items.length).map((ref, index) => [normalizeRef(ref), index]));
  const matched: Array<OutputItem | undefined> = new Array(i.items.length);

  for (const entry of i.output.items) {
    const index = indexByRef.get(normalizeRef(entry.ref));
    if (index === undefined) {
      repairs.push(`AI returned an unknown item reference "${cap(entry.ref, 20)}"`);
    } else if (matched[index]) {
      repairs.push(`AI returned item ${i.items[index].label} more than once; kept the first`);
    } else {
      matched[index] = entry;
    }
  }

  const missing = i.items.filter((_item, index) => !matched[index]);
  if (missing.length * 2 > i.items.length) {
    throw new AiError("invalid_output", `The AI returned judgments for only ${i.items.length - missing.length} of ${i.items.length} items.`, {
      retryable: true,
    });
  }
  for (const item of missing) repairs.push(`AI returned no judgment for item ${item.label}`);
  return matched;
}

function normalizeRef(ref: string): string {
  return ref.replace(/[[\]]/g, "").trim().toUpperCase();
}

/**
 * Applies the consistency rules in order: no answer means not attempted, not attempted means no answer,
 * a (nearly) correct partial attempt is complete, an attempt with nothing transcribed gets low confidence,
 * then pages are normalized and text capped. Each fix is recorded as a repair except the benign ones:
 * promoting a partial attempt to complete, rounding, deduping and sorting pages, and the text caps.
 */
function toJudgment(o: OutputItem, label: string, pageCount: number, repairs: string[]): ItemJudgment {
  let { attempt, correctness, confidence } = o;
  const studentAnswer = cap(o.student_answer, CAPS.studentAnswer);

  if (correctness === "no_answer" && attempt !== "none") {
    attempt = "none";
    repairs.push(`Item ${label}: judged "no answer" but marked attempted; set to not attempted`);
  }
  if (attempt === "none" && correctness !== "no_answer") {
    correctness = "no_answer";
    confidence = "low";
    repairs.push(`Item ${label}: marked not attempted but judged; set to no answer with low confidence`);
  }
  if ((correctness === "correct" || correctness === "minor_error") && attempt === "partial") {
    attempt = "complete"; // a (nearly) correct answer is a complete attempt; benign, not a repair
  }
  if (attempt !== "none" && studentAnswer === "" && confidence !== "low") {
    confidence = "low";
    repairs.push(`Item ${label}: attempted but no answer was transcribed; confidence lowered`);
  }

  const pages = normalizePages(o.pages, pageCount);
  if (pages.outOfRange) repairs.push(`Item ${label}: page numbers outside 1–${pageCount} were corrected`);

  return {
    attempt,
    correctness,
    legibility: o.legibility,
    confidence,
    reviewReason: o.review_reason,
    studentAnswer,
    pages: pages.pages,
    whatStudentDid: cap(o.what_student_did, CAPS.itemNote),
    feedback: cap(o.feedback, CAPS.itemNote),
    teacherNote: cap(o.teacher_note, CAPS.itemNote),
  };
}

/** Rounds, clamps to 1..pageCount, dedupes and sorts. Only clamping counts as a repair; order and duplicates are cosmetic. */
function normalizePages(pages: number[], pageCount: number): { pages: number[]; outOfRange: boolean } {
  let outOfRange = false;
  const clamped = pages.map((page) => {
    const rounded = Math.round(page);
    const valid = Math.min(Math.max(rounded, 1), Math.max(pageCount, 1));
    if (valid !== rounded) outOfRange = true;
    return valid;
  });
  return { pages: [...new Set(clamped)].sort((a, b) => a - b), outOfRange };
}

function resolveIdentity(i: ReconcileInput): { fields: IdentityFields; sectionMatch: SectionMatch["kind"] | "teacher" } {
  const { student } = i.output;
  const aiName = capOrNull(student.name, CAPS.name);
  const aiSectionRaw = capOrNull(student.section_raw, CAPS.section);
  const aiSectionMatch = capOrNull(student.section_match, CAPS.section);
  const { current } = i;

  const name = current.nameSource === "teacher"
    ? { studentName: current.studentName, nameSource: current.nameSource, nameKey: current.nameKey, nameSortKey: current.nameSortKey }
    : aiNameFields(aiName);

  let section: Pick<IdentityFields, "sectionId" | "sectionSource">;
  let sectionMatch: SectionMatch["kind"] | "teacher";
  if (current.sectionSource === "teacher") {
    section = { sectionId: current.sectionId, sectionSource: current.sectionSource };
    sectionMatch = "teacher";
  } else {
    const match = resolveSection(aiSectionRaw, aiSectionMatch, i.sections);
    const sectionId = "sectionId" in match ? match.sectionId : null;
    section = { sectionId, sectionSource: sectionId ? "ai" : null };
    sectionMatch = match.kind;
  }

  return {
    fields: {
      aiName,
      aiNameConfidence: student.name_confidence,
      aiSectionRaw,
      aiSectionMatch,
      sectionKey: canonicalSectionKey(aiSectionRaw),
      ...name,
      ...section,
    },
    sectionMatch,
  };
}

function aiNameFields(aiName: string | null): Pick<IdentityFields, "studentName" | "nameSource" | "nameKey" | "nameSortKey"> {
  const studentName = cleanName(aiName);
  return {
    studentName,
    nameSource: studentName ? "ai" : null,
    nameKey: nameKey(studentName),
    nameSortKey: nameSortKey(studentName),
  };
}

function judgmentFlags(judgments: ItemJudgment[]): FlagCode[] {
  const flags: FlagCode[] = [];
  if (judgments.length > 0 && judgments.every((j) => j.attempt === "none")) flags.push("blank_submission");
  if (judgments.some((j) => j.confidence === "low")) flags.push("low_confidence");
  if (judgments.some((j) => (j.legibility === "illegible" && j.attempt !== "none") || j.correctness === "cannot_judge")) {
    flags.push("illegible");
  }
  if (judgments.some((j) => j.reviewReason !== "none")) flags.push("item_review");
  return flags;
}

/**
 * Identity flags for a submission's current identity fields. Fields the teacher set raise no
 * flags, and the name-reading flags only apply when there is a name.
 */
export function identityFlags(
  s: Pick<Submission, "studentName" | "nameSource" | "aiNameConfidence" | "aiSectionRaw" | "sectionId" | "sectionSource">,
  sectionMatch: SectionMatch["kind"] | "teacher",
  hasSections: boolean,
): FlagCode[] {
  const flags: FlagCode[] = [];
  if (s.nameSource !== "teacher") {
    if (s.studentName === null) flags.push("name_missing");
    else if (s.aiNameConfidence === "low") flags.push("name_unclear");
    else if (s.aiNameConfidence === "medium") flags.push("name_uncertain");
  }
  if (s.sectionSource !== "teacher") {
    if (hasSections && s.sectionId === null) flags.push("section_unmatched");
    const loose = sectionMatch === "fuzzy" || sectionMatch === "hint" || (sectionMatch === "only" && s.aiSectionRaw !== null);
    if (loose) flags.push("section_inferred");
  }
  return sortFlags(flags);
}

/** The result stored when the AI refuses a paper: no judgments, identity unchanged, sent to the teacher. */
export function buildRefusedResult(i: {
  items: KeyItem[];
  current: ReconcileInput["current"] & Pick<Submission, "aiNameConfidence" | "aiSectionRaw" | "aiSectionMatch" | "sectionKey" | "documentMatch" | "aiName">;
  hasSections: boolean;
  category: string | null;
}): Reconciled {
  const { current } = i;
  const sectionMatch = current.sectionSource === "teacher" ? "teacher" : current.sectionId ? "exact" : "none";
  const flags = sortFlags(["ai_refused", ...identityFlags(current, sectionMatch, i.hasSections)]);
  return {
    items: i.items.map((item) => ({ itemId: item.id, judgment: null })),
    repairs: [],
    fields: {
      aiName: current.aiName,
      aiNameConfidence: current.aiNameConfidence,
      aiSectionRaw: current.aiSectionRaw,
      aiSectionMatch: current.aiSectionMatch,
      sectionKey: current.sectionKey,
      studentName: current.studentName,
      nameSource: current.nameSource,
      nameKey: current.nameKey,
      nameSortKey: current.nameSortKey,
      sectionId: current.sectionId,
      sectionSource: current.sectionSource,
      documentMatch: current.documentMatch,
      flags,
      teacherSummary: `The AI declined to grade this paper (category: ${i.category ?? "unspecified"}). Enter points with overrides.`,
      integrityNote: "",
      unmatchedWork: "",
      overallFeedback: "",
    },
    status: "needs_review",
  };
}

/** Flags in FLAG_CODES order without duplicates. */
function sortFlags(flags: FlagCode[]): FlagCode[] {
  const present = new Set(flags);
  return FLAG_CODES.filter((code) => present.has(code));
}

/** Trimmed and silently cut to `max` characters. */
function cap(s: string, max: number): string {
  return truncateChars(s.trim(), max).trimEnd();
}

function capOrNull(s: string | null, max: number): string | null {
  const capped = s === null ? "" : cap(s, max);
  return capped === "" ? null : capped;
}

function joinLines(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}
