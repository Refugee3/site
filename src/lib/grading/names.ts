import { truncateChars } from "@/lib/grading/text";

const MAX_NAME_LENGTH = 120;
/** The sort key of an unnamed paper; it sorts after every name. */
export const UNNAMED_SORT_KEY = "~";
// Generational suffixes are ignored when finding the surname ("Maria de la Cruz Jr." sorts under "cruz").
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
const APOSTROPHES = /['’ʼ]/g;
const COMBINING_MARKS = /\p{M}/gu;
const NON_LETTERS = /[^\p{L}]+/gu;
const WORD_START = /(^|[\s\-'’])(\p{L})/gu;

/** A display name: trimmed, whitespace collapsed, ALL CAPS or all-lowercase turned into Title Case, at most 120 characters. */
export function cleanName(raw: string | null): string | null {
  const collapsed = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (collapsed === "") return null;
  const name = isSingleCase(collapsed) ? titleCase(collapsed) : collapsed;
  return truncateChars(name, MAX_NAME_LENGTH).trim();
}

function isSingleCase(s: string): boolean {
  const upper = s.toUpperCase();
  const lower = s.toLowerCase();
  return upper !== lower && (s === upper || s === lower);
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(WORD_START, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

/** Lowercase letter-only words with accents removed: "María O'Brien-Lopez" → ["maria", "obrien", "lopez"]. */
function nameWords(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .split(NON_LETTERS)
    .filter((word) => word !== "");
}

/** An order-independent identity for a name, so "Lopez, Maria" and "maría lopez" are the same student. */
export function nameKey(name: string | null): string | null {
  const words = nameWords(name ?? "");
  return words.length > 0 ? words.sort().join(" ") : null;
}

/**
 * Whether two name readings are clearly different students. They are the same when every word of the shorter
 * name pairs up with a word of the other: the same word, an initial of it ("J" and "Jayden"), or a near spelling
 * (one letter off in words of 4 to 6 letters, two in longer words; words of 3 letters or fewer must be equal).
 * So a first name alone ("Maria" for "Maria Garcia"), an added middle name, or a slightly different reading of
 * the handwriting ("Jayden" and "Jaydon") is not a new student. A null or wordless name never differs.
 */
export function namesDiffer(a: string | null, b: string | null): boolean {
  const wordsA = nameWords(a ?? "");
  const wordsB = nameWords(b ?? "");
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const [fewer, more] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const unused = [...more];
  for (const word of fewer) {
    const exact = unused.indexOf(word);
    const at = exact >= 0 ? exact : unused.findIndex((other) => wordsMatch(word, other));
    if (at < 0) return true;
    unused.splice(at, 1);
  }
  return false;
}

/** Whether the two names have a word in common, exactly ("Maria Garcia" and "Maria Lopez"). */
export function namesShareWord(a: string | null, b: string | null): boolean {
  const wordsB = new Set(nameWords(b ?? ""));
  return nameWords(a ?? "").some((word) => wordsB.has(word));
}

function wordsMatch(a: string, b: string): boolean {
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  const shorter = Math.min(a.length, b.length);
  return editDistance(a, b) <= (shorter <= 3 ? 0 : shorter <= 6 ? 1 : 2);
}

/** Levenshtein distance (names are short, so the full table is cheap). */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Sorts by surname, then given names: "Lopez, Maria" → "lopez maria"; unnamed papers get "~" and sort last. */
export function nameSortKey(name: string | null): string {
  if (name === null) return UNNAMED_SORT_KEY;
  const comma = name.indexOf(",");
  const words = comma >= 0
    ? [...withoutSuffixes(nameWords(name.slice(0, comma))), ...withoutSuffixes(nameWords(name.slice(comma + 1)))]
    : surnameFirst(withoutSuffixes(nameWords(name)));
  return words.length > 0 ? words.join(" ") : UNNAMED_SORT_KEY;
}

/** "maria de la cruz" → "cruz maria de la": the last word is taken as the surname. */
function surnameFirst(words: string[]): string[] {
  return words.length > 1 ? [words[words.length - 1], ...words.slice(0, -1)] : words;
}

function withoutSuffixes(words: string[]): string[] {
  const kept = [...words];
  while (kept.length > 1 && NAME_SUFFIXES.has(kept[kept.length - 1])) kept.pop();
  return kept;
}
