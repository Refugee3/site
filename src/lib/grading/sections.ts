import { charLength } from "@/lib/grading/text";
import type { Section } from "@/lib/types";

const MAX_SECTION_LABEL = 60;

// "&.,:;#-_/\()[]'" from §6.4, plus the typographic apostrophes and dashes that phones and word processors produce.
const SEPARATORS = /[&.,:;#\-_/\\()[\]'‘’–—]/g;
const LETTER_THEN_DIGIT = /(\p{L})(\d)/gu;
const DIGIT_THEN_LETTER = /(\d)(\p{L})/gu;
const DIGITS = /^\d+$/;

const FILLER_WORDS = new Set([
  "section", "sec", "sect", "period", "per", "pd", "p", "class", "cls", "block", "blk",
  "hour", "hr", "group", "grp", "room", "rm", "no", "num", "number",
]);
const ORDINAL_SUFFIXES = new Set(["st", "nd", "rd", "th"]);
const NUMBER_WORDS = new Map<string, string>(
  [
    ["one", "first"], ["two", "second"], ["three", "third"], ["four", "fourth"], ["five", "fifth"], ["six", "sixth"],
    ["seven", "seventh"], ["eight", "eighth"], ["nine", "ninth"], ["ten", "tenth"], ["eleven", "eleventh"], ["twelve", "twelfth"],
  ].flatMap(([cardinal, ordinal], index) => [[cardinal, String(index + 1)], [ordinal, String(index + 1)]]),
);
// Single letters such as "i", "v" and "x" are also plausible section names, so numerals are only
// converted right after a filler word ("Per III", "Block IV").
const ROMAN_NUMERALS = new Map(
  ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"].map((numeral, index) => [numeral, String(index + 1)]),
);

/**
 * A spelling-independent key for a written section, so "Period 3", "P3", "3rd period", "Sec. 003",
 * "Per III" and "third" all become "3" (§6.4). Null when nothing identifying is left.
 */
export function canonicalSectionKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(SEPARATORS, " ")
    .replace(LETTER_THEN_DIGIT, "$1 $2")
    .replace(DIGIT_THEN_LETTER, "$1 $2")
    .trim();
  if (text === "") return null;

  const tokens = text.split(/\s+/);
  const kept: string[] = [];
  tokens.forEach((token, index) => {
    const previous = index > 0 ? tokens[index - 1] : null;
    if (FILLER_WORDS.has(token)) return;
    if (ORDINAL_SUFFIXES.has(token) && previous !== null && DIGITS.test(previous)) return;
    const number = NUMBER_WORDS.get(token)
      ?? (previous !== null && FILLER_WORDS.has(previous) ? ROMAN_NUMERALS.get(token) : undefined);
    if (number !== undefined) kept.push(number);
    else if (DIGITS.test(token)) kept.push(token.replace(/^0+(?=\d)/, ""));
    else kept.push(token);
  });
  return kept.length > 0 ? kept.join(" ") : null;
}

export interface ParsedSection {
  label: string;
  aliases: string[];
  canonicalKey: string;
}

/**
 * Parses the teacher's sections textarea: one section per line as "Label | alias, alias".
 * Every spelling must identify exactly one section, otherwise the line is reported in `errors`.
 */
export function parseSectionsText(text: string): { sections: ParsedSection[]; errors: string[] } {
  const sections: ParsedSection[] = [];
  const errors: string[] = [];
  const owners = new Map<string, { label: string; line: number }>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    if (rawLine.trim() === "") return;
    const [labelPart, ...aliasParts] = rawLine.split("|");
    const label = labelPart.trim();
    const aliases = unique(aliasParts.join(",").split(",").map((alias) => alias.trim()).filter((alias) => alias !== ""));
    if (label === "") {
      errors.push(`Line ${line}: put the section name before the "|".`);
      return;
    }

    const spellings = [label, ...aliases].map((spelling) => ({ spelling, key: canonicalSectionKey(spelling) }));
    const lineErrors = spellings.map(({ spelling, key }) => spellingError(spelling, key, line)).filter((e) => e !== null);
    if (lineErrors.length > 0) {
      errors.push(...lineErrors);
      return;
    }

    const keyed = spellings.filter((s): s is KeyedSpelling => s.key !== null);
    const clash = clashError(keyed, owners, line);
    if (clash) {
      errors.push(clash);
      return;
    }
    for (const { key } of keyed) owners.set(key, { label, line });
    sections.push({ label, aliases, canonicalKey: keyed[0].key });
  });

  return { sections, errors };
}

interface KeyedSpelling {
  spelling: string;
  key: string;
}

/** Reports the first spelling that an earlier line already uses for its section. */
function clashError(spellings: KeyedSpelling[], owners: Map<string, { label: string; line: number }>, line: number): string | null {
  for (const { spelling, key } of spellings) {
    const owner = owners.get(key);
    if (owner) {
      return `Line ${line}: "${spelling}" is the same section as "${owner.label}" on line ${owner.line}; `
        + `put ${spelling} as an alias instead (${owner.label} | ${spelling}).`;
    }
  }
  return null;
}

function spellingError(spelling: string, key: string | null, line: number): string | null {
  if (charLength(spelling) > MAX_SECTION_LABEL) {
    return `Line ${line}: "${spelling.slice(0, 20)}…" is longer than ${MAX_SECTION_LABEL} characters.`;
  }
  if (key === null) return `Line ${line}: "${spelling}" does not identify a section; add its number or name.`;
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** The textarea form of configured sections; `parseSectionsText` reads it back unchanged. */
export function sectionsToText(s: Section[]): string {
  return [...s]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((section) => (section.aliases.length > 0 ? `${section.label} | ${section.aliases.join(", ")}` : section.label))
    .join("\n");
}

export type SectionMatch = { kind: "exact" | "fuzzy" | "hint" | "only"; sectionId: string } | { kind: "none" } | { kind: "unconfigured" };

/** Matches what a student wrote (and the AI's pick from the list) to one configured section (§6.4). */
export function resolveSection(raw: string | null, aiHint: string | null, sections: Section[]): SectionMatch {
  if (sections.length === 0) return { kind: "unconfigured" };
  if (sections.length === 1) return { kind: "only", sectionId: sections[0].id };

  const key = canonicalSectionKey(raw);
  if (key !== null) {
    const exact = sections.filter((section) => sectionKeys(section).includes(key));
    if (exact.length === 1) return { kind: "exact", sectionId: exact[0].id };

    const digits = digitSignature(key);
    if (digits !== null) {
      const fuzzy = sections.filter((section) => sectionKeys(section).some((k) => digitSignature(k) === digits));
      if (fuzzy.length === 1) return { kind: "fuzzy", sectionId: fuzzy[0].id };
    }
  }

  const hint = aiHint?.trim().toLowerCase();
  if (hint) {
    const hinted = sections.filter((section) => section.label.trim().toLowerCase() === hint);
    if (hinted.length === 1) return { kind: "hint", sectionId: hinted[0].id };
  }
  return { kind: "none" };
}

/** Canonical keys of a section's label and aliases (the stored key is included in case it was computed elsewhere). */
function sectionKeys(section: Section): string[] {
  const computed = [section.label, ...section.aliases].map((spelling) => canonicalSectionKey(spelling));
  return [section.canonicalKey, ...computed].filter((key): key is string => key !== null);
}

/** The key's digit tokens as a sorted multiset, or null when it has none. */
function digitSignature(key: string): string | null {
  const digits = key.split(" ").filter((token) => DIGITS.test(token));
  return digits.length > 0 ? digits.sort().join(" ") : null;
}
