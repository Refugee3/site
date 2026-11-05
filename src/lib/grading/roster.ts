import { cleanName, editDistance, nameWords } from "@/lib/grading/names";
import { truncateChars } from "@/lib/grading/text";

// The class list (roster) of an assignment (pure): the teacher pastes one student per line, optionally with a section
// ("Maria Lopez | Period 3"). A name read on a paper is matched to it tolerantly: case and accents don't matter, the words
// may come in any order ("Lopez, Maria"), a word may be an initial ("M. Lopez") or a little misspelt ("Mria Lopes"), and a
// first name alone counts when only one student has it. The list's spelling (and section) is then used; a reading that
// could be two students, or matches none, keeps the reading and is flagged.

export interface RosterEntry {
  name: string;
  /** As the teacher wrote it ("Period 3"), or null. */
  section: string | null;
}

export const MAX_ROSTER_ENTRIES = 400;
const MAX_NAME = 120;
const MAX_SECTION = 60;

/** One student per line; "Name | Section" (or a tab) adds a section. Blank lines, "#" comments and repeats are ignored. */
export function parseRoster(text: string): RosterEntry[] {
  const seen = new Set<string>();
  const out: RosterEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [namePart, ...rest] = line.split(/\s*[|\t]\s*/);
    const name = cleanName(truncateChars(namePart.trim(), MAX_NAME));
    if (!name || nameWords(name).length === 0) continue;
    const key = nameWords(name).sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const section = truncateChars(rest.join(" ").trim(), MAX_SECTION).trim();
    out.push({ name, section: section === "" ? null : section });
    if (out.length >= MAX_ROSTER_ENTRIES) break;
  }
  return out;
}

/** The roster as the teacher would type it (for the editor). */
export function rosterToText(entries: RosterEntry[]): string {
  return entries.map((e) => (e.section ? `${e.name} | ${e.section}` : e.name)).join("\n");
}

export type RosterMatch =
  | { kind: "match"; entry: RosterEntry; score: number }
  | { kind: "ambiguous"; candidates: RosterEntry[] }
  | { kind: "none" };

/** At least this score is a match… */
export const ROSTER_MATCH_SCORE = 0.72;
/** …when the next student scores this much less; closer, the reading could be either. */
export const ROSTER_MARGIN = 0.12;
/** Candidates for "could be either" score at least this. */
const ROSTER_CANDIDATE_SCORE = 0.6;

/** The roster entry a name read on a paper is, if one clearly is. */
export function matchRoster(reading: string | null, roster: RosterEntry[]): RosterMatch {
  const read = nameWords(reading ?? "").filter((w) => w.length > 0);
  if (read.length === 0 || roster.length === 0) return { kind: "none" };
  const scored = roster
    .map((entry) => ({ entry, score: nameScore(read, nameWords(entry.name)) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best.score >= ROSTER_MATCH_SCORE && best.score - (second?.score ?? 0) >= ROSTER_MARGIN) {
    return { kind: "match", entry: best.entry, score: best.score };
  }
  const close = scored.filter((s) => s.score >= ROSTER_CANDIDATE_SCORE && best.score - s.score < ROSTER_MARGIN);
  if (close.length >= 2) return { kind: "ambiguous", candidates: close.slice(0, 3).map((s) => s.entry) };
  return { kind: "none" };
}

/**
 * How well the words read match a roster name, 0..1: each word read is paired with the most similar unused word of the
 * name (any order), and the score is the mean of the share of the reading explained and the share of the name covered.
 * A first name alone thus scores 0.75 against "First Last", and 1 against itself.
 */
export function nameScore(read: string[], name: string[]): number {
  if (read.length === 0 || name.length === 0) return 0;
  const unused = [...name];
  let total = 0;
  for (const word of read) {
    let bestAt = -1;
    let best = 0;
    unused.forEach((other, i) => {
      const s = wordSimilarity(word, other);
      if (s > best) {
        best = s;
        bestAt = i;
      }
    });
    if (bestAt >= 0) {
      total += best;
      unused.splice(bestAt, 1);
    }
  }
  return (total / read.length + total / name.length) / 2;
}

/** 1 for the same word, 0.7 for an initial of it, else by spelling (one letter off in "maria"/"mria" is 0.8); 0 below 0.5. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 0.7 : 0;
  const s = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  return s >= 0.5 ? s : 0;
}
