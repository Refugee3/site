import { type AutoMark, normalizeAnswerText, parseChoiceLetters, parseTrueFalse } from "@/lib/grading/auto-mark";
import type { AnswerType, KeyItem } from "@/lib/types";
import type { ChoiceReading } from "./decide";
import { normalizeLabel } from "./text-zones";
import type { QuestionSpots, SpotKind } from "./types";

// Linking answer spots to the key (pure): which key item each question's spots answer, which printed option the key's answer
// is, and the program's mark for a choice read from the marks.

/** The spots used for each key item: the first enabled, linked, usable question spots per item (by key position). */
export function planSpots(spots: QuestionSpots[], items: Array<Pick<KeyItem, "label">>): Map<number, QuestionSpots> {
  const indexByLabel = new Map<string, number>();
  items.forEach((item, i) => {
    const label = normalizeLabel(item.label);
    if (!indexByLabel.has(label)) indexByLabel.set(label, i);
  });
  const plan = new Map<number, QuestionSpots>();
  for (const spot of spots) {
    if (!spot.enabled || spot.itemLabel === null || !isUsable(spot)) continue;
    const index = indexByLabel.get(normalizeLabel(spot.itemLabel));
    if (index !== undefined && !plan.has(index)) plan.set(index, spot);
  }
  return plan;
}

export function isUsable(spot: QuestionSpots): boolean {
  return spot.kind === "choice" ? spot.options.length >= 2 : spot.boxes.length > 0;
}

/** The kind of spot a key answer type is read with by default (a new spot drawn by the teacher, or a type change). */
export function defaultKindFor(type: AnswerType): SpotKind {
  switch (type) {
    case "multiple_choice":
    case "true_false":
      return "choice";
    case "matching":
      return "matching";
    case "diagram":
      return "diagram";
    default:
      return "write_in";
  }
}

const TRUE_FALSE = new Set(["True", "False"]);
const YES_NO = new Set(["Yes", "No"]);

/**
 * The key's accepted answers as sets of option values of this question (one set per accepted answer; "B or D" is two, "B, D"
 * one). [] when the key's answer names none of the options (the judge then compares the marked option's value itself).
 */
export function keyChoiceSets(item: Pick<KeyItem, "expectedAnswer" | "acceptableAnswers">, values: string[]): Set<string>[] {
  const accepted = [item.expectedAnswer, ...item.acceptableAnswers].map((a) => a.trim()).filter((a) => a !== "");
  const valueSet = new Set(values);
  const letters = values.every((v) => /^[A-J]$/.test(v));
  const digits = values.every((v) => /^\d$/.test(v));
  const sets: Set<string>[] = [];
  const add = (set: Set<string>) => {
    if (set.size > 0 && [...set].every((v) => valueSet.has(v)) && !sets.some((s) => sameSet(s, set))) sets.push(set);
  };
  for (const answer of accepted.flatMap((a) => a.split(/\s+or\s+/i))) {
    if (letters) {
      const parsed = parseChoiceLetters(answer);
      if (parsed) {
        add(parsed);
        continue;
      }
    }
    if (values.every((v) => TRUE_FALSE.has(v))) {
      const tf = parseTrueFalse(answer, { leading: true });
      if (tf !== null) {
        add(new Set([tf ? "True" : "False"]));
        continue;
      }
    }
    if (values.every((v) => YES_NO.has(v))) {
      const word = /^\s*(yes|no)\b/i.exec(answer)?.[1];
      if (word) {
        add(new Set([word.toLowerCase() === "yes" ? "Yes" : "No"]));
        continue;
      }
    }
    if (digits) {
      const digit = /^\s*\(?(\d)\)?(?:[\s.):]|$)/.exec(answer)?.[1];
      if (digit) {
        add(new Set([digit]));
        continue;
      }
    }
    // A word option ("are"), or an option's text: matched exactly.
    const text = normalizeAnswerText(answer);
    const matches = values.filter((v) => normalizeAnswerText(v) === text);
    if (matches.length === 1) add(new Set(matches));
  }
  return sets;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export interface ChoiceMarkContext {
  /** The teacher ruled on this item before: the judge applies rulings, so a wrong-looking answer goes to it. */
  hasRuling: boolean;
  /** The assignment's grading notes ("Q3: accept B or C") may change what is right: only an exact match is marked here. */
  teacherNotes: string;
}

/**
 * The program's mark for a choice question read from its marks, or null when the judge must decide (the key names no
 * option, or a teacher's ruling or notes may accept another answer). A blank is always marked here; a reading the teacher
 * should check keeps that review reason.
 */
export function markChoice(
  item: Pick<KeyItem, "expectedAnswer" | "acceptableAnswers">, values: string[], reading: ChoiceReading, multi: boolean,
  ctx: ChoiceMarkContext,
): AutoMark | null {
  if (reading.marked.length === 0) {
    return { correctness: "no_answer", confidence: reading.confidence, review_reason: reading.review, basis: "blank" };
  }
  const accepted = keyChoiceSets(item, values);
  if (accepted.length === 0) return null;
  const marked = new Set(reading.marked);
  const right = accepted.some((set) => sameSet(set, marked));
  if (!right && (ctx.hasRuling || ctx.teacherNotes.trim() !== "")) return null;
  // Several marks where the key wants one: wrong, and the teacher checks (a crossed-out choice, or a change of mind).
  const several = marked.size > 1 && !multi && accepted.every((set) => set.size === 1);
  const review = several ? "multiple_answers" : reading.review === "multiple_answers" && right ? "none" : reading.review;
  return { correctness: right ? "correct" : "incorrect", confidence: reading.confidence, review_reason: review, basis: "compared" };
}
