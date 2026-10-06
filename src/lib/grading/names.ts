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
