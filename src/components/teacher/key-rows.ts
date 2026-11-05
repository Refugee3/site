import { formatPoints, parsePointsInput } from "@/lib/format";
import { MAX_ITEM_POINTS_CENTI } from "@/lib/grading/scoring";
import type { AnswerSource, AnswerType, Confidence, KeyItem, SaveKeyInput } from "@/lib/types";
import { POINTS_FORMAT_ERROR } from "./points";

/** One row of the key editor as the teacher types it (numbers stay text until saving). */
export interface DraftRow {
  /** Stable React key: the item id, or a client-made key for a row that is not saved yet. */
  key: string;
  id: string | null;
  label: string;
  groupLabel: string;
  prompt: string;
  answerType: AnswerType;
  expectedAnswer: string;
  /** Other accepted answers, one per line. */
  acceptableText: string;
  gradingCriteria: string;
  pointsText: string;
  partialCredit: boolean;
  pageText: string;
  answerSource: AnswerSource;
  aiConfidence: Confidence | null;
  aiNote: string;
  /** Counted in the grade ("Grade this question"). */
  graded: boolean;
}

type SaveKeyRow = SaveKeyInput["items"][number];
export type RowField = Exclude<keyof SaveKeyRow, "id" | "partialCredit" | "graded">;
export type FieldErrors = Record<string, string[]>;

export function draftFromItem(item: KeyItem): DraftRow {
  return {
    key: item.id,
    id: item.id,
    label: item.label,
    groupLabel: item.groupLabel,
    prompt: item.prompt,
    answerType: item.answerType,
    expectedAnswer: item.expectedAnswer,
    acceptableText: item.acceptableAnswers.join("\n"),
    gradingCriteria: item.gradingCriteria,
    pointsText: formatPoints(item.pointsCenti),
    partialCredit: item.partialCredit,
    pageText: item.page === null ? "" : String(item.page),
    answerSource: item.answerSource,
    aiConfidence: item.aiConfidence,
    aiNote: item.aiNote,
    graded: item.graded,
  };
}

/**
 * A new teacher-written row that continues from `previous`: the next label ("4" → "5", "3a" → "3b"),
 * the same group for lettered parts, and the same type, points and partial credit.
 */
export function newDraftRow(key: string, previous?: DraftRow): DraftRow {
  const label = previous ? nextLabel(previous.label) : "1";
  const continuesPart = previous !== undefined && /^\d+[a-z]$/i.test(previous.label.trim());
  return {
    key,
    id: null,
    label,
    groupLabel: continuesPart && label !== "" ? previous.groupLabel : "",
    prompt: "",
    answerType: previous?.answerType ?? "short_answer",
    expectedAnswer: "",
    acceptableText: "",
    gradingCriteria: "",
    pointsText: previous?.pointsText ?? "1",
    partialCredit: previous?.partialCredit ?? true,
    pageText: previous?.pageText ?? "",
    answerSource: "teacher",
    aiConfidence: null,
    aiNote: "",
    graded: true,
  };
}

export function nextLabel(label: string): string {
  const text = label.trim();
  if (/^\d+$/.test(text)) return String(Number(text) + 1);
  const part = /^(\d+)([a-y])$/i.exec(text);
  if (part) return part[1] + String.fromCharCode(part[2].charCodeAt(0) + 1);
  return "";
}

/** Amber rows: the AI was not sure of the item or its answer. */
export function isUncertain(row: DraftRow): boolean {
  return row.aiConfidence === "low" || row.aiConfidence === "medium";
}

/** Saving needs the "I checked the AI-proposed answers" box while any such row remains. */
export function needsAcknowledgement(rows: DraftRow[]): boolean {
  return rows.some((row) => row.answerSource === "ai_proposed");
}

/** Item points in centipoints: required, more than 0, at most 1000. NaN-free. */
export function parseItemPoints(text: string): { ok: true; centi: number } | { ok: false; error: string } {
  const centi = parsePointsInput(text);
  if (centi === null) return { ok: false, error: "Enter the points for this item." };
  if (Number.isNaN(centi)) return { ok: false, error: POINTS_FORMAT_ERROR };
  if (centi === 0) return { ok: false, error: "Points must be more than 0." };
  if (centi > MAX_ITEM_POINTS_CENTI) return { ok: false, error: `Use at most ${formatPoints(MAX_ITEM_POINTS_CENTI)} points.` };
  return { ok: true, centi };
}

function parsePage(text: string): { ok: true; page: number | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, page: null };
  const page = Number(trimmed);
  if (/^\d+$/.test(trimmed) && page >= 1) return { ok: true, page };
  return { ok: false, error: "Enter a page number (1, 2, …) or leave it empty." };
}

export function acceptableAnswers(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

export function totalPointsCenti(rows: DraftRow[]): number {
  return rows.reduce((sum, row) => {
    const points = parseItemPoints(row.pointsText);
    return points.ok ? sum + points.centi : sum;
  }, 0);
}

/**
 * Turns the editor's rows into the save payload, checking what the browser can check (label, points, page)
 * so the teacher sees those mistakes without a round trip. The server validates everything again.
 */
export function buildSaveKeyInput(
  rows: DraftRow[],
  teacherNotes: string,
  acknowledgeAiProposed: boolean,
): { ok: true; input: SaveKeyInput } | { ok: false; fieldErrors: FieldErrors } {
  const fieldErrors: FieldErrors = {};
  const addError = (field: string, message: string) => {
    (fieldErrors[field] ??= []).push(message);
  };

  const items = rows.map((row, index): SaveKeyRow => {
    if (row.label.trim() === "") addError(`items.${index}.label`, "Give the item a label.");
    const points = parseItemPoints(row.pointsText);
    if (!points.ok) addError(`items.${index}.pointsCenti`, points.error);
    const page = parsePage(row.pageText);
    if (!page.ok) addError(`items.${index}.page`, page.error);
    return {
      id: row.id,
      label: row.label,
      groupLabel: row.groupLabel,
      prompt: row.prompt,
      answerType: row.answerType,
      expectedAnswer: row.expectedAnswer,
      acceptableAnswers: acceptableAnswers(row.acceptableText),
      gradingCriteria: row.gradingCriteria,
      pointsCenti: points.ok ? points.centi : 0,
      partialCredit: row.partialCredit,
      page: page.ok ? page.page : null,
      graded: row.graded,
    };
  });

  if (needsAcknowledgement(rows) && !acknowledgeAiProposed) {
    addError("acknowledgeAiProposed", "Check the AI-proposed answers, then tick the box to confirm.");
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, input: { teacherNotes, acknowledgeAiProposed, items } };
}

/** The errors of one row, by field ("items.<index>.<field>" keys from the client check or the server). */
export function rowErrors(fieldErrors: FieldErrors, index: number): Partial<Record<RowField, string[]>> {
  const prefix = `items.${index}.`;
  const errors: Partial<Record<RowField, string[]>> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    if (key.startsWith(prefix)) errors[key.slice(prefix.length) as RowField] = messages;
  }
  return errors;
}

const FIELD_NAMES: Record<RowField, string> = {
  label: "label",
  groupLabel: "group",
  prompt: "question",
  answerType: "type",
  expectedAnswer: "expected answer",
  acceptableAnswers: "also accept",
  gradingCriteria: "criteria",
  pointsCenti: "points",
  page: "page",
};

/** One readable line per error, in row order, for the summary next to the save buttons. */
export function describeErrors(fieldErrors: FieldErrors, rows: DraftRow[]): string[] {
  const rowLines: Array<[number, string]> = [];
  const otherLines: string[] = [];
  for (const [key, messages] of Object.entries(fieldErrors)) {
    const match = /^items\.(\d+)\.(\w+)$/.exec(key);
    if (match) {
      const index = Number(match[1]);
      const name = rows[index]?.label.trim() || String(index + 1);
      const field = FIELD_NAMES[match[2] as RowField] ?? match[2];
      for (const message of messages) rowLines.push([index, `Item ${name}, ${field}: ${message}`]);
    } else {
      const prefix = key === "teacherNotes" ? "Teacher's notes: " : "";
      for (const message of messages) otherLines.push(prefix + message);
    }
  }
  return [...rowLines.sort((a, b) => a[0] - b[0]).map(([, line]) => line), ...otherLines];
}

/** The editor's content without the client-only row keys, for telling whether anything changed since loading. */
export function draftsSnapshot(rows: DraftRow[], teacherNotes: string): string {
  return JSON.stringify([teacherNotes, rows.map((row) => ({ ...row, key: undefined }))]);
}

export interface SplitRequest {
  /** How many parts ("" when the names or the per-part points say). */
  partsText: string;
  /** "5" (shared equally), "2, 2, 1" (one per part), or "" (the item's current points, shared). */
  pointsText: string;
  /** Optional part names: "setup, work, answer". */
  namesText: string;
}

const PART_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const MAX_PARTS = 26;

function listOf(text: string): string[] {
  return text.split(/[,;\n]/).map((part) => part.trim()).filter((part) => part !== "");
}

/** `totalCenti` in `n` shares that add up exactly (the odd centipoints go to the first parts). */
function equalShares(totalCenti: number, n: number): number[] {
  const base = Math.floor(totalCenti / n);
  return Array.from({ length: n }, (_, i) => base + (i < totalCenti - base * n ? 1 : 0));
}

/**
 * The key editor's "Split into parts": one row as several ("3" → "3a", "3b", "3c", grouped under "3"), each with its share of
 * the points and a criterion naming its part, so the AI grades each part on its own. The first part keeps the row's id (and
 * React key); `newKey(i)` names the others.
 */
export function splitDraftRow(
  row: DraftRow,
  request: SplitRequest,
  newKey: (i: number) => string,
): { ok: true; rows: DraftRow[] } | { ok: false; error: string } {
  const names = listOf(request.namesText);
  const pointList = listOf(request.pointsText);
  const partsTyped = request.partsText.trim();
  const n = partsTyped !== "" ? Number(partsTyped) : names.length > 1 ? names.length : pointList.length > 1 ? pointList.length : NaN;
  if (!Number.isInteger(n) || n < 2 || n > MAX_PARTS) return { ok: false, error: `Enter how many parts, from 2 to ${MAX_PARTS}.` };
  if (names.length > 0 && names.length !== n) return { ok: false, error: `Give ${n} part names, or none.` };

  let centi: number[];
  if (pointList.length > 1) {
    if (pointList.length !== n) return { ok: false, error: `Give ${n} point values (one per part), or one total.` };
    const parsed = pointList.map(parseItemPoints);
    const bad = parsed.find((p) => !p.ok);
    if (bad && !bad.ok) return { ok: false, error: bad.error };
    centi = parsed.map((p) => (p.ok ? p.centi : 0));
  } else {
    const total = parseItemPoints(pointList[0] ?? row.pointsText);
    if (!total.ok) return { ok: false, error: pointList.length === 0 ? "Enter the question's total points." : total.error };
    if (total.centi < n) return { ok: false, error: "That's too few points to share between the parts." };
    centi = equalShares(total.centi, n);
  }

  const label = row.label.trim();
  const group = label || row.groupLabel.trim();
  const partLabel = (i: number) => (/\d$/.test(label) ? `${label}${PART_LETTERS[i]}` : `${label || "part"}.${i + 1}`);
  return {
    ok: true,
    rows: Array.from({ length: n }, (_, i): DraftRow => {
      const what = names.length === n ? `part ${PART_LETTERS[i]}: ${names[i]}` : `part ${PART_LETTERS[i]} of ${n}`;
      return {
        ...row,
        key: i === 0 ? row.key : newKey(i),
        id: i === 0 ? row.id : null,
        label: partLabel(i).slice(0, 40),
        groupLabel: group.slice(0, 40),
        prompt: (row.prompt.trim() ? `${row.prompt.trim()} (${what})` : `Question ${group}, ${what}`).slice(0, 1000),
        gradingCriteria: [`Grade only this part of question ${group} (${what}).`, row.gradingCriteria.trim()].filter((c) => c !== "").join(" ").slice(0, 1000),
        pointsText: formatPoints(centi[i]),
        partialCredit: true,
        aiNote: "",
      };
    }),
  };
}
