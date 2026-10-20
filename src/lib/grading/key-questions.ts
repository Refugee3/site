import type { KeyExtraction } from "@/lib/ai/schemas";
import { MAX_ITEM_POINTS_CENTI } from "@/lib/grading/scoring";
import { charLength, truncateChars } from "@/lib/grading/text";
import type { AssignmentKind, KeyItem, KeyQuestion, NewKeyItem, NewKeyQuestion } from "@/lib/types";

// The AI's clarifying questions about an answer key, and how the teacher's answers change the key: deterministically, in code,
// without another AI call. Answers that can't be mapped onto items go to the teacher's notes, which the grader reads with every paper.

export const LIMITS = {
  /** The prompt asks for at most 6; a few more are tolerated, the rest dropped. */
  questions: 8,
  question: 500,
  itemLabel: 40,
  answer: 2000,
  choices: 8,
  choice: 100,
  title: 120,
  expectedAnswer: 2000,
  gradingCriteria: 1000,
  teacherNotes: 4000,
} as const;

// ---------------------------------------------------------------------------------------------
// Titles

const PLACEHOLDER_TITLE: Record<AssignmentKind, string> = { homework: "Untitled homework", quiz: "Untitled quiz" };

/** The title of an assignment started by dropping its key, until the AI suggests one or the teacher renames it. */
export function placeholderTitle(kind: AssignmentKind): string {
  return PLACEHOLDER_TITLE[kind];
}

export function isPlaceholderTitle(title: string): boolean {
  return Object.values(PLACEHOLDER_TITLE).includes(title.trim());
}

/** The AI's suggested title, tidied: one line, at most LIMITS.title characters; null when it gave none. */
export function normalizeSuggestedTitle(x: Pick<KeyExtraction, "suggested_title">): string | null {
  const title = (x.suggested_title ?? "").replace(/\s+/g, " ").trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  return title === "" ? null : truncateChars(title, LIMITS.title).trim();
}

// ---------------------------------------------------------------------------------------------
// Extracted questions → stored questions

/** The AI's questions as stored: trimmed, within the column limits, empty ones dropped, at most LIMITS.questions. */
export function normalizeExtractedQuestions(x: Pick<KeyExtraction, "questions_for_teacher">): NewKeyQuestion[] {
  const seen = new Set<string>();
  const out: NewKeyQuestion[] = [];
  for (const q of x.questions_for_teacher) {
    const question = truncateChars(q.question.replace(/\s+/g, " ").trim(), LIMITS.question);
    if (question === "" || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    const label = truncateChars((q.item_label ?? "").trim(), LIMITS.itemLabel);
    const suggested = truncateChars((q.suggested_answer ?? "").trim(), LIMITS.answer);
    const choices = [...new Set(q.choices.map((c) => truncateChars(c.trim(), LIMITS.choice)).filter((c) => c !== ""))].slice(0, LIMITS.choices);
    out.push({ kind: q.kind, itemLabel: label === "" ? null : label, question, suggestedAnswer: suggested === "" ? null : suggested, choices });
    if (out.length === LIMITS.questions) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Matching labels

type LabeledItem = Pick<KeyItem, "label" | "groupLabel">;

/** "Q4b", "question 4b", "#4b", "No. 4b", " 4B " → "4b". */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/^(?:questions?|problems?|items?|exercises?|q|no\.?|#)\s*\.?\s*/, "")
    .replace(/[\s.)]+$/g, "")
    .replace(/\s+/g, "");
}

/** The index of the item whose label is `label` (normalized), else -1. */
export function findItemIndex(items: readonly LabeledItem[], label: string | null): number {
  if (label === null) return -1;
  const wanted = normalizeLabel(label);
  if (wanted === "") return -1;
  return items.findIndex((item) => normalizeLabel(item.label) === wanted);
}

// ---------------------------------------------------------------------------------------------
// Points answers

// "twenty-five" before "twenty" and "five", which would otherwise turn it into the range "20-5".
const WORD_NUMBERS: Record<string, number> = {
  "twenty-five": 25, zero: 0, half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};

const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const UNIT = String.raw`(?:\s*(?:points?|pts?\.?|marks?|p))?`;
const EACH = String.raw`(?:\s*(?:each|apiece|per (?:question|item|part|problem)|a (?:question|piece)|for each))?`;
const ONE_LABEL = String.raw`[0-9]+[a-z]?(?:\.[a-z0-9]+)?|[a-z]`;
const LABEL_SPEC = String.raw`(?:${ONE_LABEL})(?:\s*(?:-|to|through|thru)\s*(?:q(?:uestions?)?\s*)?(?:${ONE_LABEL}))?`;
const LABEL_PREFIX = String.raw`(?:q(?:uestions?)?|problems?|items?|exercises?|nos?\.?|#)\s*\.?\s*`;
/** "all", "each", "the rest", "everything else", "every question", "others", "all other questions". */
const DEFAULT_WORDS = String.raw`(?:(?:all|each|every|any)(?:\s+(?:the\s+)?(?:other|remaining))?(?:\s+(?:questions?|items?|problems?|parts?|ones?))?|(?:the\s+)?rest|(?:all\s+)?others?|everything(?:\s+else)?|remaining(?:\s+(?:questions?|items?|ones?))?|(?:the\s+)?other(?:\s+(?:questions?|items?|ones?))?)`;
const VERB = String.raw`(?:\s*(?::|=|->|→)\s*|\s+(?:is|are|=)\s+(?:worth\s+)?|\s+worth\s+|\s+gets?\s+|\s+)`;

const UNIFORM_RE = new RegExp(String.raw`^(?:${DEFAULT_WORDS}${VERB})?(?:worth\s+)?${NUM}${UNIT}${EACH}(?:\s+(?:for\s+)?${DEFAULT_WORDS})?$`);
const LABELED_RE = new RegExp(String.raw`^(?:${LABEL_PREFIX})?(${LABEL_SPEC})${VERB}(?:worth\s+)?${NUM}${UNIT}${EACH}$`);
const LABELED_AFTER_RE = new RegExp(String.raw`^${NUM}${UNIT}${EACH}\s+(?:for|on)\s+(?:${LABEL_PREFIX})?(${LABEL_SPEC})$`);

type Clause = { spec: string | null; centi: number };

/** "2", "2.5", "two" → centipoints within the item limits; null for anything else. */
function toCenti(text: string): number | null {
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const centi = Math.round(value * 100);
  return centi >= 1 && centi <= MAX_ITEM_POINTS_CENTI ? centi : null;
}

function normalizePointsText(text: string): string {
  let t = text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  for (const [word, value] of Object.entries(WORD_NUMBERS)) t = t.replace(new RegExp(String.raw`\b${word}\b`, "g"), String(value));
  // "all 1 except Q6 which is 3" → "all 1, Q6 is 3"; "and" between clauses ("1-5: 1 and 6: 3").
  return t
    .replace(/\s*\b(?:except(?: for)?|but|apart from|other than)\b\s*/g, ", ")
    .replace(/\b(?:which|that) (?:is|are)\b/g, "is")
    .replace(/\s+and\s+(?=(?:q(?:uestions?)?\s*)?[0-9]+[a-z]?\s*(?:[-:=]|(?:is|are|to|through|thru|worth|gets?)\b))/g, ", ")
    .replace(/\s+and\s+(?=(?:the rest|rest|others?|all|everything)\b)/g, ", ");
}

function parseClause(clause: string): Clause | null {
  const c = clause.trim().replace(/^(?:and|then)\s+/, "");
  let m = UNIFORM_RE.exec(c);
  if (m) {
    const centi = toCenti(m[1]);
    return centi === null ? null : { spec: null, centi };
  }
  m = LABELED_RE.exec(c);
  if (m) {
    const centi = toCenti(m[2]);
    return centi === null ? null : { spec: m[1], centi };
  }
  m = LABELED_AFTER_RE.exec(c);
  if (m) {
    const centi = toCenti(m[1]);
    return centi === null ? null : { spec: m[2], centi };
  }
  return null;
}

/** The leading number and the rest of a normalized label: "12b" → [12, "b"]; null for a label without a leading number. */
function splitLabel(label: string): [number, string] | null {
  const m = /^(\d+)(.*)$/.exec(label);
  return m ? [Number(m[1]), m[2]] : null;
}

/** Item indexes a label spec ("6", "3b", "1-5", "3a-3c", "q2 to q4") covers; empty when it names nothing in the key. */
function itemsForSpec(items: readonly LabeledItem[], spec: string): { indexes: number[]; split: boolean } {
  const parts = spec.split(/\s*(?:-|to|through|thru)\s*/).map(normalizeLabel);
  if (parts.length === 1) {
    const exact = items.flatMap((item, i) => (normalizeLabel(item.label) === parts[0] ? [i] : []));
    if (exact.length > 0) return { indexes: exact, split: false };
    // A whole question with parts ("Q3: 2" for 3a and 3b): its value is shared by the parts, like group_points.
    const group = items.flatMap((item, i) => (normalizeLabel(item.groupLabel) === parts[0] ? [i] : []));
    return { indexes: group, split: true };
  }
  const [from, to] = [splitLabel(parts[0]), splitLabel(parts[1])];
  if (!from || !to) return { indexes: [], split: false };
  const indexes = items.flatMap((item, i) => {
    const own = splitLabel(normalizeLabel(item.label));
    if (!own) return [];
    const [n, rest] = own;
    if (from[1] === "" && to[1] === "") return n >= from[0] && n <= to[0] ? [i] : [];
    // "3a-3c": parts of one question, by letter.
    if (from[0] === to[0] && n === from[0]) return rest >= from[1] && rest <= to[1] ? [i] : [];
    // "2b-4": from a part of one question to a later question.
    const afterStart = n > from[0] || (n === from[0] && rest >= from[1]);
    const beforeEnd = n < to[0] || (n === to[0] && (to[1] === "" || rest <= to[1]));
    return afterStart && beforeEnd ? [i] : [];
  });
  return { indexes, split: false };
}

/**
 * Best-effort reading of a teacher's answer about points: "2", "2 each", "2 points", "all 1", "Q1-5: 1, Q6: 3", "1-5 = 1 pt; 6 = 3 pts",
 * "1 point each except question 6 which is 3", "3 for Q4", "two each". Returns the new points (centipoints) of the items it sets, by
 * item index, or null when any part of it can't be read or names an item the key doesn't have. A bare value applies to every item,
 * or only to `target` (the item the question was about) when there is one; labeled values win over the default. A value for a
 * question with parts and no item of its own ("Q3: 2" for 3a and 3b) is split equally across its parts, the remainder to the last.
 */
export function parsePointsAnswer(answer: string, items: readonly LabeledItem[], target: string | null = null): Map<number, number> | null {
  const text = normalizePointsText(answer);
  if (text === "" || items.length === 0) return null;
  const clauses = text.split(/\s*[,;\n]\s*/).filter((c) => c !== "");
  const parsed = clauses.map(parseClause);
  if (parsed.length === 0 || parsed.some((c) => c === null)) return null;

  const result = new Map<number, number>();
  const defaults = (parsed as Clause[]).filter((c) => c.spec === null);
  if (defaults.length > 1) return null;
  if (defaults.length === 1) {
    const targetIndex = findItemIndex(items, target);
    const scope = target !== null && targetIndex >= 0 && parsed.length === 1 ? [targetIndex] : items.map((_, i) => i);
    for (const i of scope) result.set(i, defaults[0].centi);
  }
  for (const clause of parsed as Clause[]) {
    if (clause.spec === null) continue;
    const { indexes, split } = itemsForSpec(items, clause.spec);
    if (indexes.length === 0) return null;
    if (split) {
      if (clause.centi < indexes.length) return null;
      const share = Math.floor(clause.centi / indexes.length);
      indexes.forEach((index, k) => result.set(index, k === indexes.length - 1 ? clause.centi - share * (indexes.length - 1) : share));
    } else {
      for (const index of indexes) result.set(index, clause.centi);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Answers → key

const YES_RE = /^\s*(?:y|yes|yeah|yep|yup|sure|ok|okay|true|accept(?: them| it)?|of course|definitely|please do|do)\b/i;

export function isYes(answer: string): boolean {
  return YES_RE.test(answer);
}

export type AnsweredItem = NewKeyItem & { id: string };

export interface AppliedAnswers {
  items: AnsweredItem[];
  teacherNotes: string;
  /** The lines added to the teacher's notes. */
  notes: string[];
  /** Ids of the items an answer changed. */
  changedItemIds: string[];
}

export const NOTES_HEADING = "Answers to the AI's questions about the key:";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function noteLine(q: Pick<KeyQuestion, "question">, answer: string): string {
  return `${oneLine(q.question)} Answer: ${oneLine(answer)}`;
}

function appendCriteria(criteria: string, addition: string): string {
  const base = criteria.trim();
  if (base.includes(addition)) return base;
  return truncateChars(base === "" ? addition : `${base} ${addition}`, LIMITS.gradingCriteria);
}

/**
 * Applies the teacher's answers to the key, in question order:
 * - missing_answer → that item's expected answer, now the teacher's (answer_source "teacher"); without a matching item, a note;
 * - points → the items' points, read by parsePointsAnswer; an answer it can't read becomes a note;
 * - accept_equivalents → a note, and a "yes" also adds a line to the item's grading criteria;
 * - partial_credit, ambiguous_item, other → a note.
 * Notes are appended to the teacher's notes under NOTES_HEADING (cut to the notes limit). Questions without an answer are ignored.
 */
export function applyKeyAnswers(i: {
  items: readonly KeyItem[];
  teacherNotes: string;
  questions: ReadonlyArray<Pick<KeyQuestion, "kind" | "itemLabel" | "question" | "answer">>;
}): AppliedAnswers {
  const items: AnsweredItem[] = i.items.map((item) => ({
    id: item.id, label: item.label, groupLabel: item.groupLabel, prompt: item.prompt, answerType: item.answerType,
    expectedAnswer: item.expectedAnswer, acceptableAnswers: [...item.acceptableAnswers], gradingCriteria: item.gradingCriteria,
    pointsCenti: item.pointsCenti, partialCredit: item.partialCredit, page: item.page, answerSource: item.answerSource,
    aiConfidence: item.aiConfidence, aiNote: item.aiNote,
  }));
  const changed = new Set<string>();
  const notes: string[] = [];

  for (const q of i.questions) {
    const answer = (q.answer ?? "").trim();
    if (answer === "") continue;
    const index = findItemIndex(items, q.itemLabel);
    switch (q.kind) {
      case "missing_answer": {
        if (index < 0) {
          notes.push(noteLine(q, answer));
          break;
        }
        items[index] = { ...items[index], expectedAnswer: truncateChars(answer, LIMITS.expectedAnswer), answerSource: "teacher" };
        changed.add(items[index].id);
        break;
      }
      case "points": {
        const points = parsePointsAnswer(answer, items, q.itemLabel);
        if (!points) {
          notes.push(noteLine(q, answer));
          break;
        }
        for (const [at, centi] of points) {
          if (items[at].pointsCenti === centi) continue;
          items[at] = { ...items[at], pointsCenti: centi };
          changed.add(items[at].id);
        }
        break;
      }
      case "accept_equivalents": {
        notes.push(noteLine(q, answer));
        if (index >= 0 && isYes(answer)) {
          const criteria = appendCriteria(items[index].gradingCriteria, "Accept equivalent forms (the teacher said yes when asked).");
          if (criteria !== items[index].gradingCriteria) {
            items[index] = { ...items[index], gradingCriteria: criteria };
            changed.add(items[index].id);
          }
        }
        break;
      }
      case "partial_credit":
      case "ambiguous_item":
      case "other":
        notes.push(noteLine(q, answer));
        break;
    }
  }

  return { items, teacherNotes: appendNotes(i.teacherNotes, notes), notes, changedItemIds: [...changed] };
}

/** The teacher's notes with `lines` added under NOTES_HEADING (once), cut to the notes limit. */
export function appendNotes(teacherNotes: string, lines: string[]): string {
  const base = teacherNotes.trim();
  if (lines.length === 0) return base;
  const bullets = lines.map((line) => `- ${line}`).join("\n");
  const joined = base.includes(NOTES_HEADING) ? `${base}\n${bullets}` : `${base}${base === "" ? "" : "\n\n"}${NOTES_HEADING}\n${bullets}`;
  return charLength(joined) > LIMITS.teacherNotes ? truncateChars(joined, LIMITS.teacherNotes) : joined;
}
