// "Only grade 2, 4b and 5" / "Skip question 1" in the teacher's grading instructions → which key items count (pure). The editor
// offers to tick the "Grade this" boxes to match; the instructions themselves are still sent to the AI as written.

export interface GradingScope {
  mode: "only" | "skip";
  /** The key labels it names, in key order. */
  labels: string[];
  /** Question names it mentions that aren't in the key ("7" in a 6-question key). */
  unknown: string[];
}

const ONLY = /\b(?:only\s+(?:grade|score|check|mark|count)|(?:grade|score|check|mark|count)\s+only|just\s+(?:grade|score|check|mark|count)|only\s+(?:questions?|parts?|items?|problems?|#))\b/i;
const SKIP = /\b(?:skip|ignore|exclude|leave\s+out|don'?t\s+(?:grade|score|count|check)|do\s+not\s+(?:grade|score|count|check)|not\s+graded)\b/i;

/** "Q3", "3)", "3(b)", "3.b", "3 b" → "3b"; lower case. */
function norm(label: string): string {
  return label.toLowerCase().replace(/^(?:question|q|problem|#)\s*/, "").replace(/[\s().:\-]/g, "");
}

/** The question names in a clause: "2, 4b and 5", "1-3", "3 parts b and c", "questions 3(a) through 3(c)". */
function mentioned(clause: string): string[] {
  const out: string[] = [];
  const text = clause.toLowerCase().replace(/\bthrough\b|\bthru\b|\bto\b/g, "-");
  // "3 parts b and c" / "question 3, parts a, c"
  for (const m of text.matchAll(/(\d{1,3})\s*,?\s*parts?\s+((?:[a-j](?:\s*(?:,|and|&)\s*)?)+)/g)) {
    for (const part of m[2].split(/\s*(?:,|\band\b|&|\bor\b)\s*/)) if (/^[a-j]$/.test(part.trim())) out.push(`${m[1]}${part.trim()}`);
  }
  const rest = text.replace(/(\d{1,3})\s*,?\s*parts?\s+((?:[a-j](?:\s*(?:,|and|&)\s*)?)+)/g, " ");
  // Ranges "1-5" and "3a-3c".
  for (const m of rest.matchAll(/(\d{1,3})([a-j])?\s*-\s*(\d{1,3})?([a-j])?\b/g)) {
    const [, fromN, fromL, toN, toL] = m;
    if (fromL && toL && (!toN || toN === fromN)) {
      for (let c = fromL.charCodeAt(0); c <= toL.charCodeAt(0); c++) out.push(`${fromN}${String.fromCharCode(c)}`);
    } else if (toN && !fromL && !toL && Number(toN) >= Number(fromN) && Number(toN) - Number(fromN) <= 100) {
      for (let n = Number(fromN); n <= Number(toN); n++) out.push(String(n));
    }
  }
  const singles = rest.replace(/(\d{1,3})([a-j])?\s*-\s*(\d{1,3})?([a-j])?\b/g, " ");
  for (const m of singles.matchAll(/(?:^|[^\w])(?:q|#)?\s*(\d{1,3})\s*(?:\(?\s*([a-j])\s*\)?)?(?![\w])/g)) out.push(`${m[1]}${m[2] ?? ""}`);
  return [...new Set(out.map(norm))];
}

/**
 * The scope the instructions ask for, or null when they don't say which questions to grade. A number that names a group with
 * lettered parts ("3" when the key has 3a, 3b) covers all its parts.
 */
export function gradingScopeFromText(text: string, keyLabels: string[]): GradingScope | null {
  for (const sentence of text.split(/[.;\n]+/)) {
    const only = ONLY.exec(sentence);
    const skip = only ? null : SKIP.exec(sentence);
    const hit = only ?? skip;
    if (!hit) continue;
    const names = mentioned(sentence.slice(hit.index + hit[0].length));
    if (names.length === 0) continue;
    const keyed = keyLabels.map((label) => ({ label, n: norm(label) }));
    const labels = new Set<string>();
    const unknown: string[] = [];
    for (const name of names) {
      const exact = keyed.filter((k) => k.n === name);
      const parts = /^\d+$/.test(name) ? keyed.filter((k) => new RegExp(`^${name}[a-z]$`).test(k.n)) : [];
      const matched = exact.length > 0 ? exact : parts;
      if (matched.length === 0) unknown.push(name);
      for (const k of matched) labels.add(k.label);
    }
    if (labels.size === 0) continue;
    return { mode: only ? "only" : "skip", labels: keyLabels.filter((l) => labels.has(l)), unknown };
  }
  return null;
}

/** Which labels count under the scope. */
export function gradedUnder(scope: GradingScope, keyLabels: string[]): Set<string> {
  const named = new Set(scope.labels);
  return new Set(keyLabels.filter((label) => (scope.mode === "only" ? named.has(label) : !named.has(label))));
}
