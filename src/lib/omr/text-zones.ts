import type { AnswerType } from "@/lib/types";
import type { QuestionSpots, SpotBox, SpotKind, SpotOption } from "./types";

// Finding the answer spots on a digital blank worksheet from its text layer (pure). The page's words come with their boxes;
// the question labels ("1.", "2)", "Q3", "3a)", and "a)" under 3 when the key has a 3a) split the page into questions, and
// within each question the printed options (A–D, (a)…, 1–4, True/False, T/F, Yes/No, "is / are", check boxes and bubbles)
// become choice spots, and runs of underscores write-in spots. A question with neither is answered in the space below it.
// The key, when there is one, says which labels are questions and what kind of answer each takes.

/** A word (or underscore run, or "☐" for any check box or bubble glyph) with its box, in normalized page coordinates. */
export interface TextToken {
  text: string;
  x: number;
  /** Top of the text line. */
  y: number;
  w: number;
  h: number;
  baseline: number;
}

export interface TextPage {
  tokens: TextToken[];
  /** Page size in points: paddings are in inches. */
  widthPt: number;
  heightPt: number;
}

export interface KeyItemOutline {
  label: string;
  answerType: AnswerType;
}

interface Line {
  tokens: TextToken[];
  top: number;
  bottom: number;
  baseline: number;
}

interface Question {
  label: string;
  page: number;
  /** The label token's line and every line until the next question (same page). */
  lines: Line[];
  /** The body: every token but the label. */
  tokens: TextToken[];
  labelToken: TextToken;
  /** Where the next question starts on this page (its top), or null: the page's end. */
  nextTop: number | null;
}

/** "Q 3.", "3a)", "Question 3:" → "3a"/"3": lower case, without spaces, dots, brackets and a leading "q"/"question". */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/^(?:question|q)\s*\.?\s*(?=\d)/, "").replace(/[\s.():\-–]/g, "");
}

const NUM_LABEL = /^(?:Q|Question)?\.?(\d{1,3})([a-z])?[.):]$|^Q\.?(\d{1,3})([a-z])?$/i;
const SUB_LABEL = /^\(?([a-z])[).]$/i;
const LETTER_OPTION = /^\(?([A-Ja-j])[).:]$/;
const NUMBER_OPTION = /^\(?([1-9])[).]$/;
const PAIRS: Array<{ words: [string[], string[]]; values: [string, string] }> = [
  { words: [["true"], ["false"]], values: ["True", "False"] },
  { words: [["t"], ["f"]], values: ["True", "False"] },
  { words: [["yes"], ["no"]], values: ["Yes", "No"] },
];

/** Inches → normalized units along the page's width or height. */
function inch(page: TextPage) {
  return { x: (n: number) => (n * 72) / page.widthPt, y: (n: number) => (n * 72) / page.heightPt };
}

export function groupLines(tokens: TextToken[]): Line[] {
  const sorted = [...tokens].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines: Line[] = [];
  for (const t of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(t.baseline - line.baseline) <= Math.max(t.h, line.bottom - line.top) * 0.35) {
      line.tokens.push(t);
      line.top = Math.min(line.top, t.y);
      line.bottom = Math.max(line.bottom, t.y + t.h);
    } else {
      lines.push({ tokens: [t], top: t.y, bottom: t.y + t.h, baseline: t.baseline });
    }
  }
  for (const line of lines) line.tokens.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * The answer spots of a worksheet whose pages have a text layer. `items` is the key (may be empty): labels found in it are
 * questions, and its answer types decide between the kinds of spot a question's text allows.
 */
export function detectSpotsFromText(pages: TextPage[], items: KeyItemOutline[]): QuestionSpots[] {
  const keyByLabel = new Map(items.map((item) => [normalizeLabel(item.label), item]));
  const questions = findQuestions(pages, keyByLabel);
  const spots: QuestionSpots[] = [];
  for (const q of questions) {
    const page = pages[q.page - 1];
    const keyItem = keyByLabel.get(normalizeLabel(q.label)) ?? null;
    const spot = spotsForQuestion(q, page, keyItem);
    if (spot) spots.push({ ...spot, id: `s${spots.length + 1}` });
  }
  return spots;
}

function findQuestions(pages: TextPage[], keyByLabel: Map<string, KeyItemOutline>): Question[] {
  const keyGroups = new Set([...keyByLabel.keys()].map((label) => /^(\d+)/.exec(label)?.[1]).filter((g): g is string => !!g));
  const questions: Question[] = [];
  let lastNumber = 0;
  pages.forEach((page, pageIndex) => {
    const lines = groupLines(page.tokens);
    // Question numbers sit at the left margin; an indented "1)" is an option.
    const starts = lines.map((line) => numericLabel(line.tokens[0])).map((m, i) => (m ? lines[i].tokens[0].x : Infinity));
    const margin = Math.min(...starts);
    const tolerance = inch(page).x(0.2);
    let current: Question | null = null;
    let group: string | null = null;
    for (const line of lines) {
      const first = line.tokens[0];
      const num = numericLabel(first);
      let label: string | null = null;
      if (num && first.x <= margin + tolerance && !isOptionLine(line)) {
        const candidate = `${num.number}${num.letter ?? ""}`;
        const known = keyByLabel.size === 0 || keyByLabel.has(candidate) || keyGroups.has(num.number);
        if (known && Number(num.number) >= lastNumber) label = candidate;
      } else if (group !== null && keyByLabel.size > 0) {
        const sub = SUB_LABEL.exec(first.text);
        if (sub && keyByLabel.has(`${group}${sub[1].toLowerCase()}`)) label = `${group}${sub[1].toLowerCase()}`;
      }
      if (label !== null) {
        if (current) current.nextTop = line.top;
        const number: string = /^(\d+)/.exec(label)![1];
        lastNumber = Number(number);
        group = number;
        current = { label, page: pageIndex + 1, lines: [line], tokens: line.tokens.slice(1), labelToken: first, nextTop: null };
        questions.push(current);
      } else if (current && current.page === pageIndex + 1) {
        current.lines.push(line);
        current.tokens.push(...line.tokens);
      }
    }
  });
  // A question number followed only by sub-questions ("3." then "a)", "b)") is not answered itself.
  return questions.filter((q, i) => {
    const next = questions[i + 1];
    return !(next && /^\d+$/.test(q.label) && next.label.startsWith(q.label) && /[a-z]$/.test(next.label) && q.tokens.every((t) => !isAnswerToken(t)));
  });
}

function numericLabel(t: TextToken | undefined): { number: string; letter: string | null } | null {
  if (!t) return null;
  const m = NUM_LABEL.exec(t.text);
  if (!m) return null;
  return { number: String(Number(m[1] ?? m[3])), letter: (m[2] ?? m[4] ?? null)?.toLowerCase() ?? null };
}

/** A line with two or more option labels on it ("1) dog  2) cat") is a line of options, not a question. */
function isOptionLine(line: Line): boolean {
  return line.tokens.filter((t) => NUMBER_OPTION.test(t.text) || LETTER_OPTION.test(t.text)).length >= 2;
}

function isAnswerToken(t: TextToken): boolean {
  return t.text === "☐" || /^_{3,}$/.test(t.text) || LETTER_OPTION.test(t.text);
}

type Found = Omit<QuestionSpots, "id">;

function spotsForQuestion(q: Question, page: TextPage, keyItem: KeyItemOutline | null): Found | null {
  const unit = inch(page);
  const letters = optionRun(q.tokens, LETTER_OPTION, "A");
  const numbers = letters ? null : optionRun(q.tokens, NUMBER_OPTION, "1");
  const boxes = glyphOptions(q.tokens, unit);
  const pair = wordPair(q.tokens);
  const slash = slashOptions(q.tokens);
  const blanks = q.tokens.filter((t) => /^_{3,}$/.test(t.text));
  const labelled = letters ?? numbers;

  const choice = (options: SpotOption[]): Found => base(q, keyItem, "choice", { options: separate(options) });
  const writeIn = (kind: SpotKind): Found => base(q, keyItem, kind, {
    boxes: blanks.length > 0 ? blanks.slice(0, 6).map((t) => blankBox(t, unit)) : [regionBox(q, page)],
  });
  const labelOptions = (run: TextToken[], values: string[]) => run.map((t, i) => ({ value: values[i], box: labelBox(t, unit) }));
  const fromLabels = labelled ? labelOptions(labelled.tokens, labelled.values) : null;
  const fromWords = (words: Array<{ token: TextToken; value: string }>) => words.map((w) => ({ value: w.value, box: wordBox(w.token, unit) }));

  const type = keyItem?.answerType ?? null;
  switch (type) {
    case "multiple_choice":
      if (fromLabels) return choice(fromLabels);
      if (boxes) return choice(boxes);
      if (slash) return choice(fromWords(slash));
      if (pair) return choice(fromWords(pair));
      return writeIn("write_in");
    case "true_false":
      if (pair) return choice(fromWords(pair));
      if (boxes) return choice(boxes);
      if (fromLabels) return choice(fromLabels);
      return writeIn("write_in");
    case "matching":
      return writeIn("matching");
    case "diagram":
      return base(q, keyItem, "diagram", { boxes: [regionBox(q, page)] });
    case null:
      if (fromLabels) return choice(fromLabels);
      if (boxes) return choice(boxes);
      if (blanks.length > 0) return writeIn("write_in");
      if (slash) return choice(fromWords(slash));
      if (pair) return choice(fromWords(pair));
      return writeIn("write_in");
    default:
      // A written answer, unless the question is "circle the right word" or has check boxes and no blank.
      if (blanks.length === 0 && boxes) return choice(boxes);
      if (blanks.length === 0 && slash) return choice(fromWords(slash));
      return writeIn("write_in");
  }
}

function base(q: Question, keyItem: KeyItemOutline | null, kind: SpotKind, o: { options?: SpotOption[]; boxes?: SpotBox[] }): Found {
  return {
    label: q.label,
    itemLabel: keyItem?.label ?? null,
    kind,
    multi: false,
    enabled: true,
    page: q.page,
    options: kind === "choice" ? (o.options ?? []).map((option) => ({ ...option, box: clampBox(option.box) })) : [],
    boxes: kind === "choice" ? [] : (o.boxes ?? []).map(clampBox),
  };
}

/** The longest run of option labels A, B, C… (or 1, 2, 3…) in reading order, at least two long. */
function optionRun(tokens: TextToken[], re: RegExp, first: string): { tokens: TextToken[]; values: string[] } | null {
  const found = tokens.map((t) => ({ t, m: re.exec(t.text) })).filter((x) => x.m !== null);
  let best: TextToken[] = [];
  for (let start = 0; start < found.length; start++) {
    if (found[start].m![1].toUpperCase() !== first) continue;
    const run = [found[start].t];
    let expected = next(first);
    for (let k = start + 1; k < found.length; k++) {
      if (found[k].m![1].toUpperCase() === expected) {
        run.push(found[k].t);
        expected = next(expected);
      }
    }
    if (run.length > best.length) best = run;
  }
  if (best.length < 2) return null;
  return { tokens: best, values: best.map((t) => re.exec(t.text)![1].toUpperCase()) };
}

function next(value: string): string {
  return /^\d$/.test(value) ? String(Number(value) + 1) : String.fromCharCode(value.charCodeAt(0) + 1);
}

/** Check boxes or bubbles, each with the words after it on its line as its value ("☐ Yes ☐ No"). */
function glyphOptions(tokens: TextToken[], unit: ReturnType<typeof inch>): SpotOption[] | null {
  const glyphs = tokens.filter((t) => t.text === "☐");
  if (glyphs.length < 2) return null;
  return glyphs.map((g, i) => {
    const words: TextToken[] = [];
    const after = tokens.filter((t) => Math.abs(t.baseline - g.baseline) < g.h * 0.4 && t.x > g.x).sort((a, b) => a.x - b.x);
    let right = g.x + g.w;
    for (const t of after) {
      if (t.text === "☐" || t.x - right > unit.x(0.4) || words.length >= 4) break;
      words.push(t);
      right = t.x + t.w;
    }
    const value = words.map((w) => w.text).join(" ").replace(/[.,;:]$/, "") || String.fromCharCode(65 + i);
    const x0 = g.x - unit.x(0.08);
    const x1 = Math.max(g.x + g.w, words.length > 0 ? Math.min(right, g.x + g.w + unit.x(0.9)) : 0) + unit.x(0.08);
    return { value: cleanValue(value), box: { x: x0, y: g.y - unit.y(0.07), w: x1 - x0, h: g.h + unit.y(0.12) } };
  });
}

/** True/False, T/F or Yes/No printed as words to circle: the last occurrence of each word of the pair. */
function wordPair(tokens: TextToken[]): Array<{ token: TextToken; value: string }> | null {
  const clean = (t: TextToken) => t.text.toLowerCase().replace(/^[("'[]+|[)"'\].,;:!?/]+$/g, "");
  for (const pair of PAIRS) {
    const lastOf = (words: string[]) => tokens.filter((t) => words.includes(clean(t))).at(-1) ?? null;
    const a = lastOf(pair.words[0]);
    const b = lastOf(pair.words[1]);
    if (!a || !b || a === b) continue;
    // Printed as a choice: close together (the same line or the next), not the "True or false:" of an instruction far away.
    if (Math.abs(a.baseline - b.baseline) > 3 * a.h) continue;
    return [{ token: a, value: pair.values[0] }, { token: b, value: pair.values[1] }].sort((p, q) => p.token.baseline - q.token.baseline || p.token.x - q.token.x);
  }
  return null;
}

/** "is / are", "(is/are)", "big/small": the first group of words separated by slashes. */
function slashOptions(tokens: TextToken[]): Array<{ token: TextToken; value: string }> | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const inner = t.text.replace(/^[([{]+|[)\]}.,;:!?]+$/g, "");
    if (/^[^/\s]+(?:\/[^/\s]+)+$/.test(inner)) {
      // One token "is/are": split it by its characters.
      const parts = inner.split("/");
      const lead = t.text.indexOf(inner);
      const per = t.w / [...t.text].length;
      let offset = lead;
      return parts.map((part) => {
        const token = { ...t, text: part, x: t.x + offset * per, w: [...part].length * per };
        offset += [...part].length + 1;
        return { token, value: cleanValue(part) };
      });
    }
    if (t.text === "/" && i > 0 && i + 1 < tokens.length) {
      const words = [tokens[i - 1]];
      let k = i;
      while (k + 1 < tokens.length && tokens[k].text === "/") {
        words.push(tokens[k + 1]);
        k += 2;
      }
      return words.map((w) => ({ token: w, value: cleanValue(w.text) }));
    }
  }
  return null;
}

function cleanValue(s: string): string {
  return s.replace(/^[([{"']+|[)\]}"'.,;:!?]+$/g, "").trim() || s.trim();
}

/** An option label ("B)"), with room for a circle around it, a tick or a bubble before it, and the start of its text. */
function labelBox(t: TextToken, unit: ReturnType<typeof inch>): SpotBox {
  const x0 = t.x - unit.x(0.2);
  const x1 = t.x + t.w + unit.x(0.4);
  return { x: x0, y: t.y - unit.y(0.09), w: x1 - x0, h: t.h + unit.y(0.16) };
}

/** A word to circle ("True", "are"). */
function wordBox(t: TextToken, unit: ReturnType<typeof inch>): SpotBox {
  const x0 = t.x - unit.x(0.12);
  const x1 = t.x + t.w + unit.x(0.12);
  return { x: x0, y: t.y - unit.y(0.09), w: x1 - x0, h: t.h + unit.y(0.16) };
}

/** Options on one line never overlap: neighbours meet halfway between them. Rows are separated the same way. */
function separate(options: SpotOption[]): SpotOption[] {
  const out = options.map((o) => ({ ...o, box: { ...o.box } }));
  for (const a of out) {
    for (const b of out) {
      if (a === b) continue;
      const sameRow = a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h;
      if (sameRow && a.box.x < b.box.x && a.box.x + a.box.w > b.box.x) {
        const mid = (a.box.x + a.box.w + b.box.x) / 2;
        // Keep at least the start of each one.
        const cut = Math.max(mid, a.box.x + a.box.w * 0.35);
        const aRight = Math.min(a.box.x + a.box.w, cut);
        b.box.w = b.box.x + b.box.w - cut;
        b.box.x = cut;
        a.box.w = aRight - a.box.x;
      }
    }
  }
  for (const a of out) {
    for (const b of out) {
      if (a === b || a.box.y >= b.box.y) continue;
      const overlapX = a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w;
      if (overlapX && a.box.y + a.box.h > b.box.y) {
        const mid = (a.box.y + a.box.h + b.box.y) / 2;
        a.box.h = mid - a.box.y;
        b.box.h = b.box.y + b.box.h - mid;
        b.box.y = mid;
      }
    }
  }
  return out;
}

/** A blank to write on: the run of underscores and the room above it for handwriting. */
function blankBox(t: TextToken, unit: ReturnType<typeof inch>): SpotBox {
  const x0 = t.x - unit.x(0.04);
  const x1 = t.x + t.w + unit.x(0.04);
  const y0 = t.baseline - unit.y(0.32);
  const y1 = t.baseline + unit.y(0.08);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A question without options or blanks is answered below its text, up to the next question (or the end of the page's
 * text), across the page's text width. When there is barely room, the rest of the question's last line counts instead.
 */
function regionBox(q: Question, page: TextPage): SpotBox {
  const unit = inch(page);
  const left = Math.min(...page.tokens.map((t) => t.x));
  const right = Math.max(...page.tokens.map((t) => t.x + t.w));
  const contentBottom = Math.max(...page.tokens.map((t) => t.y + t.h));
  const last = q.lines.at(-1)!;
  const top = last.bottom + unit.y(0.03);
  const bottom = q.nextTop !== null ? q.nextTop - unit.y(0.06) : Math.min(0.97, Math.max(contentBottom + unit.y(0.3), top + unit.y(1.5)));
  if (bottom - top >= unit.y(0.3)) {
    return clampBox({ x: left - unit.x(0.05), y: top, w: right - left + unit.x(0.1), h: bottom - top });
  }
  const end = Math.max(...last.tokens.map((t) => t.x + t.w));
  const x0 = Math.min(end + unit.x(0.08), right - unit.x(1));
  return clampBox({ x: x0, y: last.top - unit.y(0.12), w: right + unit.x(0.05) - x0, h: last.bottom - last.top + unit.y(0.2) });
}

export function clampBox(b: SpotBox): SpotBox {
  const x0 = Math.max(0, Math.min(1, b.x));
  const y0 = Math.max(0, Math.min(1, b.y));
  const x1 = Math.max(0, Math.min(1, b.x + b.w));
  const y1 = Math.max(0, Math.min(1, b.y + b.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
