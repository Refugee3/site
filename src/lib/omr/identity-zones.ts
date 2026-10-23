import { clampBox, groupLines, type TextPage, type TextToken } from "./text-zones";
import type { IdentityKind, QuestionSpots, SpotBox } from "./types";

// Where the student writes their name and class on a digital blank worksheet (pure): the "Name", "Period", "Section",
// "Class", "Block", "Hour" and "Date" labels of the first page's text layer. Each identity spot is the area to the right of
// its label up to the next label on the line (or the line's blank, or the page's text edge), with room above the line for
// handwriting; a label alone at the end of its line gets the line below it. "Date" only bounds the others.

const LABELS: Array<{ re: RegExp; kind: IdentityKind | null; label: string }> = [
  { re: /^(?:student'?s?\s*)?(?:full\s*)?name$/i, kind: "name", label: "Name" },
  { re: /^(?:period|per|section|sec|class|block|hour|hr|grade|group)$/i, kind: "section", label: "Class" },
  { re: /^date$/i, kind: null, label: "Date" },
];

/**
 * The top of page 1 (about 20%) where a name is usually written: read when the blank has no name spot, so the AI never needs
 * the whole page for the name.
 */
export const TOP_STRIP: SpotBox = { x: 0, y: 0, w: 1, h: 0.2 };

interface Found {
  token: TextToken;
  kind: IdentityKind | null;
  label: string;
}

/** The label a token is ("Name:", "Period", "Class:" …), or null. */
function labelOf(text: string): Omit<Found, "token"> | null {
  const word = text.replace(/[:.#_]+$/, "").trim();
  for (const l of LABELS) if (l.re.test(word)) return { kind: l.kind, label: l.label };
  return null;
}

/**
 * The identity spots of a worksheet (its first page): at most one "name" and one "section" spot, ids `id1`, `id2`. Empty
 * when page 1 has no such labels (or no text).
 */
export function detectIdentitySpots(pages: TextPage[]): QuestionSpots[] {
  const page = pages[0];
  if (!page || page.tokens.length === 0) return [];
  const inch = { x: (n: number) => (n * 72) / page.widthPt, y: (n: number) => (n * 72) / page.heightPt };
  const textRight = Math.max(...page.tokens.map((t) => t.x + t.w));
  const lines = groupLines(page.tokens);
  const spots: QuestionSpots[] = [];
  const taken = new Set<IdentityKind>();
  lines.forEach((line, lineIndex) => {
    // A label must start a line or follow a blank/word: "Name: ____ Period: __ Date: ____".
    const labels: Found[] = line.tokens.flatMap((token) => {
      const found = labelOf(token.text);
      // "Name" in a sentence ("Write your name…") is not a label: it must end with ":" or be followed by a blank.
      if (!found) return [];
      const next = line.tokens[line.tokens.indexOf(token) + 1];
      const labelled = /:$/.test(token.text) || (next !== undefined && (/^_{2,}$/.test(next.text) || next.text === ":"));
      return labelled ? [{ token, ...found }] : [];
    });
    labels.forEach((found, i) => {
      if (found.kind === null || taken.has(found.kind)) return;
      const start = found.token.x + found.token.w + inch.x(0.03);
      const nextLabel = labels[i + 1]?.token ?? null;
      // The blank after the label, when there is one, sets the area's end; else the next label or the text edge.
      const after = line.tokens.filter((t) => t.x >= found.token.x + found.token.w - 1e-6 && (nextLabel === null || t.x < nextLabel.x));
      const blank = after.find((t) => /^_{2,}$/.test(t.text));
      const end = blank ? blank.x + blank.w + inch.x(0.05) : (nextLabel ? nextLabel.x - inch.x(0.05) : textRight + inch.x(0.05));
      let box: SpotBox;
      if (end - start >= inch.x(0.4)) {
        box = { x: start, y: line.baseline - inch.y(0.34), w: end - start, h: inch.y(0.44) };
      } else {
        // Nothing to the right: the name goes on the line below the label.
        const below = lines[lineIndex + 1];
        const top = line.bottom + inch.y(0.02);
        const bottom = below ? Math.min(below.top - inch.y(0.02), top + inch.y(0.45)) : top + inch.y(0.45);
        box = { x: found.token.x, y: top, w: Math.max(inch.x(2.5), end - found.token.x), h: Math.max(inch.y(0.25), bottom - top) };
      }
      taken.add(found.kind);
      spots.push({
        id: `id${spots.length + 1}`, label: found.token.text.replace(/[:.#_]+$/, "").trim() || found.label, itemLabel: null, kind: found.kind,
        multi: false, enabled: true, page: 1, options: [], boxes: [clampBox(box)],
      });
    });
  });
  return spots;
}
