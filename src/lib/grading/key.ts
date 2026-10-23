import type { KeyExtraction } from "@/lib/ai/schemas";
import { formatPoints } from "@/lib/format";
import { MAX_ITEM_POINTS_CENTI } from "@/lib/grading/scoring";
import { charLength, truncateChars } from "@/lib/grading/text";
import { sha256Hex } from "@/lib/ids";
import { ANSWER_TYPES, type AnswerKey, type AnswerType, type KeyItem, type NewKeyItem, type SaveKeyInput } from "@/lib/types";

// Limits shared by AI extraction and the teacher's editor; label and points mirror the key_items CHECKs.
const LIMITS = {
  label: 40,
  groupLabel: 40,
  prompt: 1000,
  expectedAnswer: 2000,
  gradingCriteria: 1000,
  acceptableAnswers: 20,
  acceptableAnswer: 500,
  aiNote: 500,
  aiNotes: 2000,
  teacherNotes: 4000,
  minPointsCenti: 1,
  maxPointsCenti: MAX_ITEM_POINTS_CENTI,
} as const;
const DEFAULT_POINTS_CENTI = 100;
const ALL_OR_NOTHING_TYPES: ReadonlySet<AnswerType> = new Set(["multiple_choice", "true_false", "matching"]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function defaultPartialCredit(t: AnswerType): boolean {
  return !ALL_OR_NOTHING_TYPES.has(t);
}

/** Approved = ready, saved by the teacher at the current revision, and not empty. */
export function isKeyApproved(k: AnswerKey, itemCount: number): boolean {
  return k.status === "ready" && k.approvedRevision === k.revision && itemCount >= 1;
}

// ---------------------------------------------------------------------------------------------
// AI extraction → key items (post-processing)

/** Turns the AI's extraction into storable key items; `fatal` is the teacher-facing reason the key failed. */
export function normalizeExtractedKey(
  x: KeyExtraction,
  o: { pageCount: number; maxItems: number },
): { items: NewKeyItem[]; aiNotes: string; fatal: string | null } {
  const fatal = extractionFatal(x, o.maxItems);
  const items = fatal === null ? normalizeItems(x, o.pageCount) : [];
  return { items, aiNotes: extractionNotes(x, items), fatal };
}

function extractionFatal(x: KeyExtraction, maxItems: number): string | null {
  if (x.document_kind === "student_work") {
    return "This looks like a student's paper, not an answer key. Upload the key or build it manually.";
  }
  if (x.document_kind === "unrelated") {
    return "This doesn't look like an answer key or worksheet. Upload the key or build it manually.";
  }
  if (x.items.length === 0) return "No questions found — upload a clearer scan or build the key manually.";
  if (x.items.length > maxItems) return `This key has more than ${maxItems} items; split the assignment.`;
  return null;
}

function normalizeItems(x: KeyExtraction, pageCount: number): NewKeyItem[] {
  const points = itemPoints(x);
  return x.items.map((item, index): NewKeyItem => {
    const notes = [truncateChars(item.note.trim(), LIMITS.aiNote), points[index].note];
    if (points[index].clampedFrom !== null) {
      notes.push(`The key's ${points[index].clampedFrom} points were outside the allowed range and became ${formatPoints(points[index].centi)}.`);
    }
    return {
      label: truncateChars(item.label.trim(), LIMITS.label) || String(index + 1),
      groupLabel: truncateChars(item.group_label.trim(), LIMITS.groupLabel),
      prompt: truncateChars(item.prompt.trim(), LIMITS.prompt),
      answerType: item.answer_type,
      expectedAnswer: truncateChars(item.expected_answer.trim(), LIMITS.expectedAnswer),
      acceptableAnswers: cleanAcceptableAnswers(item.acceptable_answers),
      gradingCriteria: truncateChars(item.grading_criteria.trim(), LIMITS.gradingCriteria),
      pointsCenti: points[index].centi,
      partialCredit: defaultPartialCredit(item.answer_type),
      page: validPage(item.page, pageCount),
      answerSource: item.answer_source,
      aiConfidence: item.confidence,
      aiNote: notes.filter((note) => note !== "").join(" "),
    };
  });
}

type ExtractedItem = KeyExtraction["items"][number];
type ItemPoints = { centi: number; clampedFrom: number | null; note: string };
/** A part's share of its question's total; no centi when the total could not be split. */
type GroupShare = { centi?: number; note: string };

/**
 * Item points in centipoints. An item's own points win. A total given only for a whole question
 * (group_points) is split equally across its parts without points, after the parts that have their
 * own; a stated document total with no item or question values is split equally across all items.
 * The remainder of a split goes to the last item. Anything else defaults to 1 pt.
 */
function itemPoints(x: KeyExtraction): ItemPoints[] {
  const count = x.items.length;
  const totalCenti = x.stated_total_points === null ? null : Math.round(x.stated_total_points * 100);
  const noValues = x.items.every((item) => item.points === null && item.group_points === null);
  const splitTotal = noValues && totalCenti !== null && totalCenti >= count && count > 0;
  const groupShares = splitTotal ? new Map<number, GroupShare>() : groupPointShares(x.items);

  return x.items.map((item, index) => {
    let centi: number;
    let fromValue: number | null; // the unclamped value in points, for the clamp note
    let note = "";
    if (splitTotal) {
      const share = Math.floor(totalCenti / count);
      centi = index === count - 1 ? totalCenti - share * (count - 1) : share;
      fromValue = centi / 100;
    } else if (item.points !== null) {
      centi = Math.round(item.points * 100);
      fromValue = item.points;
    } else {
      const share = groupShares.get(index);
      centi = share?.centi ?? DEFAULT_POINTS_CENTI;
      fromValue = centi / 100;
      note = share?.note ?? "";
    }
    const clamped = clamp(centi, LIMITS.minPointsCenti, LIMITS.maxPointsCenti);
    return { centi: clamped, clampedFrom: clamped === centi ? null : fromValue, note };
  });
}

/**
 * Each question's group_points split across its parts that have no points (keyed by item index),
 * less the points of its parts that state their own. Parts with the same group label and total form
 * one question; an item without a group label is a question of its own. A total too small to give
 * every open part at least 0.01 pt is not split, and its parts keep the default with a note.
 */
function groupPointShares(items: ExtractedItem[]): Map<number, GroupShare> {
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (item.points !== null || item.group_points === null) return;
    const label = item.group_label.trim();
    const key = label === "" ? `#${index}` : JSON.stringify([label, Math.round(item.group_points * 100)]);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });

  const shares = new Map<number, GroupShare>();
  for (const open of groups.values()) {
    const first = items[open[0]];
    const label = first.group_label.trim();
    const question = truncateChars(label || first.label.trim(), LIMITS.groupLabel) || String(open[0] + 1);
    const totalCenti = Math.round((first.group_points ?? 0) * 100);
    const ownCenti = label === "" ? 0 : items
      .filter((item) => item.group_label.trim() === label && item.points !== null)
      .reduce((sum, item) => sum + Math.round((item.points ?? 0) * 100), 0);
    const remaining = totalCenti - ownCenti;

    if (remaining < open.length) {
      const note = `Question ${question}'s ${formatPoints(Math.max(totalCenti, 0))} points could not be split across its parts; check these points.`;
      for (const index of open) shares.set(index, { note });
      continue;
    }
    const share = Math.floor(remaining / open.length);
    const note = open.length === 1 && ownCenti === 0 ? "" : `Split from question ${question}'s ${formatPoints(totalCenti)} points.`;
    open.forEach((index, i) => {
      shares.set(index, { centi: i === open.length - 1 ? remaining - share * (open.length - 1) : share, note });
    });
  }
  return shares;
}

function cleanAcceptableAnswers(answers: string[]): string[] {
  return nonEmptyTrimmed(answers)
    .map((answer) => truncateChars(answer, LIMITS.acceptableAnswer))
    .slice(0, LIMITS.acceptableAnswers);
}

function nonEmptyTrimmed(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

function validPage(page: number | null, pageCount: number): number | null {
  if (page === null) return null;
  const rounded = Math.round(page);
  return rounded >= 1 && rounded <= pageCount ? rounded : null;
}

function extractionNotes(x: KeyExtraction, items: NewKeyItem[]): string {
  // Only the model's own notes are capped, so the checks below are never cut off.
  const notes = [truncateChars(x.notes.trim(), LIMITS.aiNotes)];
  if (x.stated_total_points !== null && items.length > 0) {
    const statedCenti = Math.round(x.stated_total_points * 100);
    const sumCenti = items.reduce((sum, item) => sum + item.pointsCenti, 0);
    if (statedCenti !== sumCenti) {
      notes.push(`Key total ${formatPoints(statedCenti)} differs from the sum of item points ${formatPoints(sumCenti)}.`);
    }
  }
  if (x.document_kind === "blank_worksheet") {
    notes.push("This looks like a blank worksheet, so the AI proposed the answers itself. Check every answer before approving.");
  }
  return notes.filter((note) => note !== "").join("\n");
}

// ---------------------------------------------------------------------------------------------
// Teacher edits

type SaveKeyRow = SaveKeyInput["items"][number];
type SavedKeyItem = NewKeyItem & { id: string | null };
type FieldErrors = Record<string, string[]>;

/** Validates the key editor's rows and merges them with the stored items' provenance. */
export function validateSaveKey(
  input: SaveKeyInput,
  current: KeyItem[],
  o: { maxItems: number },
): { ok: true; items: SavedKeyItem[]; teacherNotes: string } | { ok: false; error: string; fieldErrors: FieldErrors } {
  if (input.items.length === 0) return { ok: false, error: "Add at least one item to the key.", fieldErrors: {} };
  if (input.items.length > o.maxItems) {
    return { ok: false, error: `A key can have at most ${o.maxItems} items; split the assignment.`, fieldErrors: {} };
  }

  const fieldErrors: FieldErrors = {};
  const addError = (field: string, message: string) => {
    (fieldErrors[field] ??= []).push(message);
  };

  const teacherNotes = input.teacherNotes.trim();
  if (charLength(teacherNotes) > LIMITS.teacherNotes) addError("teacherNotes", `Use at most ${LIMITS.teacherNotes} characters.`);

  const currentById = new Map(current.map((item) => [item.id, item]));
  const claimed = new Set<string>();
  let needsAcknowledgement = false;

  const items = input.items.map((row, index): SavedKeyItem => {
    for (const [field, message] of rowErrors(row)) addError(`items.${index}.${field}`, message);

    // A repeated id is treated as a new row, so two rows never overwrite one stored item.
    const existing = row.id !== null && !claimed.has(row.id) ? currentById.get(row.id) : undefined;
    if (existing) claimed.add(existing.id);
    if (existing?.answerSource === "ai_proposed") needsAcknowledgement = true;

    return {
      id: existing?.id ?? null,
      label: row.label.trim(),
      groupLabel: row.groupLabel.trim(),
      prompt: row.prompt.trim(),
      answerType: row.answerType,
      expectedAnswer: row.expectedAnswer.trim(),
      acceptableAnswers: nonEmptyTrimmed(row.acceptableAnswers),
      gradingCriteria: row.gradingCriteria.trim(),
      pointsCenti: row.pointsCenti,
      partialCredit: row.partialCredit,
      page: row.page,
      answerSource: existing && existing.answerSource !== "ai_proposed" ? existing.answerSource : "teacher",
      aiConfidence: existing?.aiConfidence ?? null,
      aiNote: existing?.aiNote ?? "",
    };
  });

  if (needsAcknowledgement && !input.acknowledgeAiProposed) {
    addError("acknowledgeAiProposed", "Check the AI-proposed answers, then tick the box to confirm.");
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Some fields need fixing before the key can be saved.", fieldErrors };
  }
  return { ok: true, items, teacherNotes };
}

function rowErrors(row: SaveKeyRow): Array<[field: string, message: string]> {
  const errors: Array<[string, string]> = [];
  const tooLong = (field: string, value: string, max: number) => {
    if (charLength(value.trim()) > max) errors.push([field, `Use at most ${max} characters.`]);
  };

  const label = row.label.trim();
  if (label === "") errors.push(["label", "Give the item a label."]);
  tooLong("label", label, LIMITS.label);
  tooLong("groupLabel", row.groupLabel, LIMITS.groupLabel);
  tooLong("prompt", row.prompt, LIMITS.prompt);
  tooLong("expectedAnswer", row.expectedAnswer, LIMITS.expectedAnswer);
  tooLong("gradingCriteria", row.gradingCriteria, LIMITS.gradingCriteria);
  if (!(ANSWER_TYPES as readonly string[]).includes(row.answerType)) errors.push(["answerType", "Choose an answer type."]);

  const answers = nonEmptyTrimmed(row.acceptableAnswers);
  if (answers.length > LIMITS.acceptableAnswers) {
    errors.push(["acceptableAnswers", `List at most ${LIMITS.acceptableAnswers} other accepted answers.`]);
  }
  if (answers.some((answer) => charLength(answer) > LIMITS.acceptableAnswer)) {
    errors.push(["acceptableAnswers", `Use at most ${LIMITS.acceptableAnswer} characters for each accepted answer.`]);
  }

  const points = row.pointsCenti;
  if (!Number.isInteger(points) || points < LIMITS.minPointsCenti || points > LIMITS.maxPointsCenti) {
    errors.push(["pointsCenti", `Points must be between ${formatPoints(LIMITS.minPointsCenti)} and ${formatPoints(LIMITS.maxPointsCenti)}.`]);
  }
  if (row.page !== null && !(Number.isInteger(row.page) && row.page >= 1)) {
    errors.push(["page", "The page must be a whole number of at least 1."]);
  }
  return errors;
}

/**
 * Identifies the judgment-relevant content of a key: when it changes, earlier grades are stale.
 * Points, partial credit, order, page and provenance are left out because none of them changes a judgment.
 */
export function keyFingerprint(
  items: Array<Pick<KeyItem, "id" | "label" | "groupLabel" | "prompt" | "answerType" | "expectedAnswer" | "acceptableAnswers" | "gradingCriteria">>,
  teacherNotes: string,
): string {
  const content = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => [item.id, item.label, item.groupLabel, item.prompt, item.answerType, item.expectedAnswer, item.acceptableAnswers, item.gradingCriteria]);
  return sha256Hex(JSON.stringify([teacherNotes, content]));
}
