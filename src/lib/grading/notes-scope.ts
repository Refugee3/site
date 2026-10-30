// Whether the teacher's grading instructions might turn a wrong-looking answer into a right one for a given item. Only then is
// a wrong objective answer (a multiple-choice letter, a number, a word) left to the AI judge, a second, slower model call; any
// other wrong answer is marked by the program. Instructions about points, parts or what to look for ("Question 3 is worth 10
// points, split into 4 parts", "Units are required") don't make a wrong letter right, so they no longer send every wrong
// answer to the judge. Pure.

/** Words that can widen what counts as right ("accept B or C", "either answer", "ignore spelling", "half credit"). */
const WIDENS = /\b(?:accept\w*|allow\w*|also\s+(?:correct|right|ok|fine|count)|either|any\s+of|equivalent|synonyms?|spelling|misspell\w*|typos?|lenient|benefit\s+of\s+the\s+doubt|half|partial|some\s+credit|full\s+credit|credit\s+for|counts?\s+as|treat\s+.+\s+as|both\s+.+\s+(?:correct|right)|(?:is|are)\s+(?:also\s+)?(?:correct|right|fine|ok)|regardless|doesn'?t\s+matter|don'?t\s+(?:mark|count)\s+(?:it\s+)?(?:wrong|off)|no\s+penalty|mistake\s+in\s+the\s+key|key\s+is\s+wrong)\b/i;

const REF = /(?:\b(?:questions?|q|problems?|prob\.?|exercises?|items?|numbers?|nos?\.?)|#)\s*((?:\d{1,3}(?:\s*\(?[a-z](?![a-z])\)?)?(?:\s*(?:,|&|\band\b|\bor\b|-|\bto\b|\bthrough\b)\s*)?)+)/gi;

function norm(label: string): string {
  return label.toLowerCase().replace(/^(?:question|q|problem|#)\s*/, "").replace(/[\s().:\-]/g, "");
}

/** The question names a sentence refers to ("Q3", "questions 2, 4 and 5", "3(b)", "1-3", "4:" at its start). */
function namesIn(sentence: string): string[] {
  const names: string[] = [];
  for (const m of sentence.matchAll(REF)) {
    const list = m[1];
    for (const range of list.matchAll(/(\d{1,3})\s*(?:-|\bto\b|\bthrough\b)\s*(\d{1,3})\b/gi)) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (to >= from && to - from <= 100) for (let n = from; n <= to; n++) names.push(String(n));
    }
    for (const one of list.matchAll(/(\d{1,3})(?:\s*\(?([a-z])(?![a-z])\)?)?/gi)) names.push(`${one[1]}${one[2] ?? ""}`.toLowerCase());
  }
  const lead = /^\s*(\d{1,3}\s*\(?[a-z]?\)?)\s*[:)]/i.exec(sentence);
  if (lead) names.push(norm(lead[1]));
  return [...new Set(names.map(norm))];
}

/**
 * True when the instructions might change whether `item`'s answer is right: a sentence that can widen what counts as right
 * and either names this item (its label, its group, or its question number) or names no question at all. Without the item's
 * label every widening sentence counts.
 */
export function notesMayChangeVerdict(notes: string, item: { label?: string; groupLabel?: string }): boolean {
  if (notes.trim() === "") return false;
  const label = item.label === undefined ? null : norm(item.label);
  const group = item.groupLabel ? norm(item.groupLabel) : "";
  for (const sentence of notes.split(/\n+|;|(?<!\d)\.(?!\d)/)) {
    if (!WIDENS.test(sentence)) continue;
    const names = namesIn(sentence);
    if (names.length === 0 || label === null) return true;
    const question = label.match(/^\d+/)?.[0] ?? "";
    if (names.some((name) => name === label || (group !== "" && name === group) || (question !== "" && name === question))) return true;
  }
  return false;
}
