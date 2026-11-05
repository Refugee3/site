import { notesMayChangeVerdict } from "@/lib/grading/notes-scope";
import type { AnswerType, Attempt, Confidence, Correctness, ItemReviewReason, KeyItem, Legibility } from "@/lib/types";

// Marking in code: after a paper has been read WITHOUT the answer key, each transcription is compared with the key here
// wherever the answer is objective (a multiple-choice letter, true/false, a number, an exact word). Only what this module
// cannot decide confidently goes to the AI judge, which sees the transcription and never the paper. Pure: no AI, no database.
//
// The rules lean towards leaving an item to the judge: a verdict here is final (the teacher still reviews flagged items and
// can override any of them), so it is only made when the comparison is unambiguous.

/** What the program decided for one item. `basis` says why, for the teacher ("exact match", "blank", "unreadable"). */
export interface AutoMark {
  correctness: Correctness;
  confidence: Confidence;
  review_reason: ItemReviewReason;
  basis: "blank" | "unreadable" | "compared";
}

/** The parts of the key item the marker uses. */
export type MarkableItem = Pick<KeyItem, "answerType" | "expectedAnswer" | "acceptableAnswers" | "gradingCriteria" | "prompt">
  & Partial<Pick<KeyItem, "label" | "groupLabel">>;

/** The parts of the blind reading the marker uses. */
export interface MarkableReading {
  student_answer: string;
  attempt: Attempt;
  legibility: Legibility;
  reading_confidence: Confidence;
}

export interface AutoMarkContext {
  /** The teacher has ruled on this item before (a lesson): the judge applies rulings, so the program never marks it. */
  hasRuling: boolean;
  /**
   * The assignment's grading instructions. When they might change what counts as right for the item ("Q3: accept B or C",
   * "ignore spelling"; see notesMayChangeVerdict), the program only gives "correct" for an exact match and leaves a wrong
   * answer to the judge.
   */
  teacherNotes: string;
}

export const ILLEGIBLE = "[illegible]";

/** Answer types whose correctness the program may decide. */
const OBJECTIVE: ReadonlySet<AnswerType> = new Set(["multiple_choice", "true_false", "numeric", "short_answer", "fill_in_blank"]);

/**
 * The program's mark for one item, or null when the judge must decide. In order:
 * - blank (attempt "none") → no_answer;
 * - attempted but nothing transcribed → cannot_judge, low confidence, ambiguous_reading;
 * - illegible (the legibility says so, or the whole answer is "[illegible]") → cannot_judge;
 * - otherwise, for objective items without a ruling and without "[illegible]" parts: the comparison for the item's type.
 * A mark from a low-confidence reading keeps that low confidence and asks the teacher to check the reading.
 */
export function autoMark(item: MarkableItem, read: MarkableReading, ctx: AutoMarkContext): AutoMark | null {
  const answer = read.student_answer.trim();
  const conf = read.reading_confidence;
  if (read.attempt === "none") return { correctness: "no_answer", confidence: conf, review_reason: "none", basis: "blank" };
  if (answer === "") return { correctness: "cannot_judge", confidence: "low", review_reason: "ambiguous_reading", basis: "unreadable" };
  if (read.legibility === "illegible" || isAllIllegible(answer)) {
    return { correctness: "cannot_judge", confidence: conf, review_reason: "none", basis: "unreadable" };
  }
  if (ctx.hasRuling || !OBJECTIVE.has(item.answerType) || answer.includes(ILLEGIBLE)) return null;

  const verdict = compare(item, answer);
  if (verdict === null) return null;
  if (verdict.correct === false && notesMayChangeVerdict(ctx.teacherNotes, item)) return null;
  const review: ItemReviewReason = verdict.multiple ? "multiple_answers" : conf === "low" ? "ambiguous_reading" : "none";
  return { correctness: verdict.correct ? "correct" : "incorrect", confidence: conf, review_reason: review, basis: "compared" };
}

interface Verdict {
  correct: boolean;
  /** The student left several answers marked where the key expects one. */
  multiple?: boolean;
}

function compare(item: MarkableItem, answer: string): Verdict | null {
  switch (item.answerType) {
    case "multiple_choice":
      return compareChoice(item, answer);
    case "true_false":
      return item.gradingCriteria.trim() === "" ? compareTrueFalse(item, answer) : null;
    case "numeric":
      return item.gradingCriteria.trim() === "" ? compareNumeric(item, answer) : null;
    case "short_answer":
    case "fill_in_blank":
      return item.gradingCriteria.trim() === "" && matchesExactly(answer, keyAnswers(item)) ? { correct: true } : null;
    default:
      return null;
  }
}

function keyAnswers(item: MarkableItem): string[] {
  return [item.expectedAnswer, ...item.acceptableAnswers].map((a) => a.trim()).filter((a) => a !== "");
}

// ---------------------------------------------------------------------------------------------
// Multiple choice

const LETTERS = "A-Ja-j";
const LETTER_LIST = new RegExp(
  `^[\\s(]*[${LETTERS}][\\s).]*(?:(?:,|;|&|\\+|/|\\band\\b|\\bor\\b)[\\s(]*[${LETTERS}][\\s).]*)*$`,
);
const LETTER_WITH_TEXT = new RegExp(`^\\(?([${LETTERS}])\\s*[).:\\]–-]\\s*\\S`);

/**
 * The option letters a string names, upper case: "B", "(b)", "B.", "B) photosynthesis", "B and D", "B, D", "B & D".
 * null when it names none (option text alone, a sentence, a number). "or" separates letters like "and" here; callers that
 * treat "or" as alternatives split on it first.
 */
export function parseChoiceLetters(raw: string): Set<string> | null {
  const s = raw.trim().replace(/^(?:answer|ans)\s*[:.-]?\s*/i, "");
  if (s === "") return null;
  if (LETTER_LIST.test(s)) {
    const letters = [...s.matchAll(new RegExp(`(?<![A-Za-z])[${LETTERS}](?![A-Za-z])`, "g"))].map((m) => m[0].toUpperCase());
    return letters.length > 0 ? new Set(letters) : null;
  }
  const withText = LETTER_WITH_TEXT.exec(s);
  return withText ? new Set([withText[1].toUpperCase()]) : null;
}

/** The option text after a leading letter ("B) photosynthesis" → "photosynthesis"); the string itself without one. */
function optionText(raw: string): string {
  const s = raw.trim();
  const m = new RegExp(`^\\(?[${LETTERS}]\\s*[).:\\]–-]\\s*(\\S.*)$`).exec(s);
  return m ? m[1] : s;
}

/**
 * The option letters a question prompt lists, when it lists at least two starting at A ("A) … B) … C) …", "(a) … (b) …");
 * null otherwise. Only the prompt is used, so the reader can be told the options without being told the answer.
 */
export function optionLettersFromPrompt(prompt: string): string[] | null {
  const found = new Set<string>();
  for (const m of prompt.matchAll(/(?:^|[\s(])\(?([A-Ja-j])[).:](?=\s|$)/g)) found.add(m[1].toUpperCase());
  const letters: string[] = [];
  for (const letter of "ABCDEFGHIJ") {
    if (!found.has(letter)) break;
    letters.push(letter);
  }
  return letters.length >= 2 ? letters : null;
}

/** Each accepted answer of the key as a set of letters; "B or D" in one answer is two accepted answers. */
function acceptedLetterSets(item: MarkableItem): Set<string>[] {
  return keyAnswers(item)
    .flatMap((answer) => answer.split(/\s+or\s+/i))
    .flatMap((part) => {
      const letters = parseChoiceLetters(part);
      return letters ? [letters] : [];
    });
}

function compareChoice(item: MarkableItem, answer: string): Verdict | null {
  const accepted = acceptedLetterSets(item);
  const marked = parseChoiceLetters(answer);
  if (marked === null) {
    // The student wrote an option's text: right only when it is exactly the expected (or an accepted) option's text.
    return matchesExactly(answer, keyAnswers(item).map(optionText)) ? { correct: true } : null;
  }
  if (accepted.length === 0) return null; // the key names no letter: the judge compares
  const options = optionLettersFromPrompt(item.prompt);
  if (options && [...marked].some((letter) => !options.includes(letter))) return null; // not an option: likely a misreading
  if (accepted.some((set) => sameSet(set, marked))) return { correct: true };
  if (marked.size > 1 && accepted.every((set) => set.size === 1)) return { correct: false, multiple: true };
  return { correct: false };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// ---------------------------------------------------------------------------------------------
// True / false

const TRUE_WORDS = new Set(["t", "true"]);
const FALSE_WORDS = new Set(["f", "false"]);

/** true / false for "T", "true", "False." …; null for anything else. With `leading`, only the first word counts ("False — …"). */
export function parseTrueFalse(raw: string, o: { leading?: boolean } = {}): boolean | null {
  const words = raw.trim().toLowerCase().split(/[\s,;:.!—–-]+/).filter((w) => w !== "");
  if (words.length === 0 || (!o.leading && words.length > 1)) return null;
  if (TRUE_WORDS.has(words[0])) return true;
  if (FALSE_WORDS.has(words[0])) return false;
  return null;
}

function compareTrueFalse(item: MarkableItem, answer: string): Verdict | null {
  const accepted = new Set(keyAnswers(item).flatMap((a) => {
    const v = parseTrueFalse(a, { leading: true });
    return v === null ? [] : [v];
  }));
  if (accepted.size !== 1) return null;
  const marked = answer.split(/\s*(?:,|;|&|\/|\band\b|\bor\b)\s*/i).map((part) => parseTrueFalse(part));
  if (marked.some((v) => v === null)) return null;
  const values = new Set(marked as boolean[]);
  if (values.size > 1) return { correct: false, multiple: true };
  return { correct: accepted.has([...values][0]) };
}

// ---------------------------------------------------------------------------------------------
// Numbers

export interface Quantity {
  value: number;
  /** Normalized unit text; "" when none. Compared exactly (case matters: "m" is not "M"). */
  unit: string;
}

const NUMBER = /^([+-]?)(?:(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(\d+(?:\.\d+)?))?)/;
/** One unit-like token ("cm", "m/s^2", "%", "°C"); words that can't be units are excluded below. */
const UNIT = /^[A-Za-zµμ°%Ω][A-Za-z0-9µμ°%Ω/^²³·*.-]{0,11}$/;
const NOT_UNITS = new Set(["or", "and", "to", "is", "not", "no", "maybe", "approx", "about", "about.", "i", "think"]);

/**
 * A number with an optional unit: "4", "x = 4", "-3.5 cm", "1/2", "1 1/2", "1,000", "50%", "9.8 m/s^2". Work written after the
 * answer ("4; work: 3x = 12") is ignored. null for anything else (two numbers, words, an expression).
 */
export function parseQuantity(raw: string): Quantity | null {
  let s = raw.split(/\s*(?:;|—|--)\s*work\s*:/i)[0];
  s = s.normalize("NFKC").replace(/[−–]/g, "-").replace(/\s+/g, " ").trim();
  s = s.replace(/^[A-Za-z][A-Za-z0-9_]*\s*(?:=|≈)\s*/, "");
  const m = NUMBER.exec(s);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  let value: number;
  if (m[2] !== undefined) {
    const den = Number(m[4]);
    if (den === 0) return null;
    value = Number(m[2]) + Number(m[3]) / den;
  } else {
    const num = Number(m[5].replace(/,/g, ""));
    if (m[6] !== undefined) {
      const den = Number(m[6]);
      if (den === 0) return null;
      value = num / den;
    } else {
      value = num;
    }
  }
  const rest = s.slice(m[0].length).trim().replace(/\.$/, "");
  if (rest !== "" && (!UNIT.test(rest) || NOT_UNITS.has(rest.toLowerCase()))) return null;
  if (!Number.isFinite(value)) return null;
  return { value: sign * value, unit: normalizeUnit(rest) };
}

function normalizeUnit(unit: string): string {
  return unit.replace(/\s+/g, "").replace(/\^2|²/g, "2").replace(/\^3|³/g, "3").replace(/[·*]/g, "").replace(/\.$/, "");
}

/** Equal within a small relative tolerance (so 0.5 = 1/2 = 2/4, but 0.33 ≠ 1/3). */
export function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Right when the number equals an accepted one and the units agree; the key's answers without units accept any unit.
 * A different number, or a unit that differs (or is missing) where the key has one, is left to the judge: it may be a
 * minor error, an equivalent form, or what the teacher's criteria allow.
 */
function compareNumeric(item: MarkableItem, answer: string): Verdict | null {
  const student = parseQuantity(answer);
  if (student === null) return null;
  const accepted = keyAnswers(item).flatMap((a) => {
    const q = parseQuantity(a);
    return q ? [q] : [];
  });
  const right = accepted.some((q) => sameNumber(q.value, student.value) && (q.unit === "" || q.unit === student.unit));
  return right ? { correct: true } : null;
}

// ---------------------------------------------------------------------------------------------
// Exact text

/**
 * Text for an exact comparison: case, whitespace and punctuation ignored (periods and commas inside numbers kept, and
 * signs, slashes and operators kept, so "-3" ≠ "3" and "3.5" ≠ "35").
 */
export function normalizeAnswerText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/(?<!\d),|,(?!\d)/g, " ")
    .replace(/[;:!?'"`“”‘’()[\]{}…]/g, " ")
    .replace(/\s+/g, "");
}

/** The answer equals one of `accepted` once normalized (never an empty one). */
export function matchesExactly(answer: string, accepted: string[]): boolean {
  const a = normalizeAnswerText(answer);
  if (a === "") return false;
  return accepted.some((candidate) => normalizeAnswerText(candidate) === a);
}

function isAllIllegible(answer: string): boolean {
  return answer.split(ILLEGIBLE).join("").replace(/[\s.,;:…-]/g, "") === "";
}
