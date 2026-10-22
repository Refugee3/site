import { degrees, PDFDocument, type PDFPage, rgb, StandardFonts } from "pdf-lib";

// Test fixtures (tests and the practice-mode smoke run): a typed blank worksheet made with pdf-lib, and "scanned" student
// papers made from it: the worksheet with pen marks (circles, filled bubbles, ticks, handwriting, crossings-out, stray dots),
// placed slightly shifted, rotated and scaled like a scanner does. Only pdf-lib is imported, so a plain Node script can use it.

const PAGE: [number, number] = [612, 792];
const LEFT = 72;
const SIZE = 12;

/** Where something printed is, in PDF points (origin bottom left): x, y of the baseline start, and its width. */
export interface Anchor {
  page: number;
  x: number;
  y: number;
  w: number;
  /** A printed check box (ticked inside it, not beside it). */
  box?: boolean;
}

export type FixtureOptions =
  | { kind: "letters"; items: string[] }
  | { kind: "words"; words: string[] }
  | { kind: "boxes"; items: string[] }
  | { kind: "slash"; before: string; words: string[]; after: string };

export interface FixtureQuestion {
  label: string;
  text: string;
  options?: FixtureOptions;
  /** A blank (underscores) after the text, on the same line. */
  blank?: boolean;
  /** Room (inches) left under the question for a written answer or a drawing. */
  room?: number;
  /** Printed as sub-questions "a)", "b)" under the label. */
  parts?: FixtureQuestion[];
}

export interface FixtureLayout {
  /** Per question label ("1", "3a"): its options' anchors by value, its blank and its room (x, y top-left, w, h). */
  questions: Record<string, {
    page: number;
    options: Record<string, Anchor>;
    blank: Anchor | null;
    room: { page: number; x: number; y: number; w: number; h: number } | null;
  }>;
}

/** The worksheet practice mode's sample key describes (Plants and Photosynthesis): choice, blanks, a drawing, an explanation. */
export const PLANTS_QUIZ: FixtureQuestion[] = [
  {
    label: "1", text: "Which process do plants use to make food from sunlight?",
    options: { kind: "letters", items: ["respiration", "photosynthesis", "digestion", "erosion"] },
  },
  { label: "2", text: "Solve 3/x = 9/12.   x =", blank: true },
  {
    label: "3", text: "Answer both parts.",
    parts: [
      { label: "a", text: "Which gas do plants take in?", blank: true },
      { label: "b", text: "Which gas do plants give off?", blank: true },
    ],
  },
  { label: "4", text: "Draw and label a plant cell.", room: 2.6 },
  { label: "5", text: "Explain why leaves look green.", room: 1.6 },
];

/** A worksheet with every kind of printed option, for the zone-detection tests. */
export const MIXED_WORKSHEET: FixtureQuestion[] = [
  { label: "1", text: "Which planet is closest to the sun?", options: { kind: "letters", items: ["Venus", "Mercury", "Mars", "Earth"] } },
  { label: "2", text: "The sun is a star.", options: { kind: "words", words: ["True", "False"] } },
  { label: "3", text: "Water boils at", blank: true },
  { label: "4", text: "Do plants need light?", options: { kind: "boxes", items: ["Yes", "No"] } },
  { label: "5", text: "Circle the correct word:", options: { kind: "slash", before: "The dogs", words: ["is", "are"], after: "barking." } },
  { label: "6", text: "Explain how a seed grows.", room: 1.4 },
];

export async function makeWorksheet(
  questions: FixtureQuestion[], o: { title?: string } = {},
): Promise<{ pdf: Uint8Array; layout: FixtureLayout }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const dingbats = await doc.embedFont(StandardFonts.ZapfDingbats);
  const layout: FixtureLayout = { questions: {} };
  let page = doc.addPage(PAGE);
  let pageNo = 1;
  let y = 740;
  page.drawText(o.title ?? "Plants and Photosynthesis Quiz", { x: LEFT, y, size: 18, font: bold });
  y -= 30;
  page.drawText("Name: ______________________    Class: ________", { x: LEFT, y, size: SIZE, font });
  y -= 40;

  const newPageIfNeeded = (need: number) => {
    if (y - need >= 60) return;
    page = doc.addPage(PAGE);
    pageNo++;
    y = 740;
  };

  const placeQuestion = (q: FixtureQuestion, labelText: string, key: string, x: number) => {
    newPageIfNeeded(40 + (q.room ?? 0) * 72);
    const entry: FixtureLayout["questions"][string] = { page: pageNo, options: {}, blank: null, room: null };
    layout.questions[key] = entry;
    page.drawText(labelText, { x, y, size: SIZE, font });
    const textX = x + font.widthOfTextAtSize(labelText, SIZE) + 6;
    page.drawText(q.text, { x: textX, y, size: SIZE, font });
    let endX = textX + font.widthOfTextAtSize(q.text, SIZE);
    if (q.blank) {
      const blank = "________________";
      const bx = endX + 8;
      page.drawText(blank, { x: bx, y, size: SIZE, font });
      entry.blank = { page: pageNo, x: bx, y, w: font.widthOfTextAtSize(blank, SIZE) };
      endX = bx + entry.blank.w;
    }
    const opts = q.options;
    if (opts?.kind === "words") {
      let ox = Math.max(endX + 40, 380);
      for (const word of opts.words) {
        page.drawText(word, { x: ox, y, size: SIZE, font });
        entry.options[word] = { page: pageNo, x: ox, y, w: font.widthOfTextAtSize(word, SIZE) };
        ox += font.widthOfTextAtSize(word, SIZE) + 40;
      }
    }
    if (opts?.kind === "boxes") {
      let ox = Math.max(endX + 30, 340);
      for (const item of opts.items) {
        page.drawText("❏", { x: ox, y, size: SIZE, font: dingbats });
        page.drawText(item, { x: ox + 16, y, size: SIZE, font });
        entry.options[item] = { page: pageNo, x: ox, y, w: 12, box: true };
        ox += 16 + font.widthOfTextAtSize(item, SIZE) + 30;
      }
    }
    y -= 22;
    if (opts?.kind === "letters") {
      const xs = [x + 18, x + 148, x + 288, x + 418];
      opts.items.forEach((item, i) => {
        const letter = `${String.fromCharCode(65 + i)})`;
        page.drawText(letter, { x: xs[i], y, size: SIZE, font });
        page.drawText(item, { x: xs[i] + 18, y, size: SIZE, font });
        entry.options[String.fromCharCode(65 + i)] = { page: pageNo, x: xs[i], y, w: font.widthOfTextAtSize(letter, SIZE) };
      });
      y -= 26;
    }
    if (opts?.kind === "slash") {
      let ox = x + 18;
      const put = (s: string) => {
        page.drawText(s, { x: ox, y, size: SIZE, font });
        const w = font.widthOfTextAtSize(s, SIZE);
        ox += w + font.widthOfTextAtSize(" ", SIZE);
        return w;
      };
      put(opts.before);
      put("(");
      opts.words.forEach((word, i) => {
        const at = ox;
        const w = put(word);
        entry.options[word] = { page: pageNo, x: at, y, w };
        if (i < opts.words.length - 1) put("/");
      });
      put(")");
      put(opts.after);
      y -= 26;
    }
    if (q.room) {
      const h = q.room * 72;
      entry.room = { page: pageNo, x: LEFT, y: y + 8, w: PAGE[0] - 2 * LEFT, h };
      y -= h;
    }
    y -= 14;
  };

  for (const q of questions) {
    if (q.parts) {
      newPageIfNeeded(60);
      page.drawText(`${q.label}.`, { x: LEFT, y, size: SIZE, font });
      page.drawText(q.text, { x: LEFT + 18, y, size: SIZE, font });
      y -= 24;
      for (const part of q.parts) placeQuestion(part, `${part.label})`, `${q.label}${part.label}`, LEFT + 18);
    } else {
      placeQuestion(q, `${q.label}.`, q.label, LEFT);
    }
  }
  return { pdf: await doc.save(), layout };
}

export type FixtureMark =
  | { q: string; circle: string }
  | { q: string; fill: string }
  | { q: string; tick: string }
  | { q: string; cross: string }
  | { q: string; dot: string }
  | { q: string; write: string }
  | { q: string; draw: true };

export interface ScanWarp {
  /** Points; positive = right / up. */
  dx?: number;
  dy?: number;
  /** Degrees, counter-clockwise. */
  rotate?: number;
  scale?: number;
}

const INK = rgb(0.12, 0.14, 0.42);

/**
 * A student's paper: the worksheet with `marks`, then each page placed onto a fresh page shifted, rotated (about its centre)
 * and scaled by `warp`, as a scanner would. `name` is written on the name line.
 */
export async function makeMarkedPaper(
  worksheet: { pdf: Uint8Array; layout: FixtureLayout }, marks: FixtureMark[], o: { warp?: ScanWarp; name?: string } = {},
): Promise<Uint8Array> {
  const marked = await PDFDocument.load(worksheet.pdf);
  const hand = await marked.embedFont(StandardFonts.CourierBoldOblique);
  const pages = marked.getPages();
  if (o.name) pages[0].drawText(o.name, { x: 118, y: 713, size: 15, font: hand, color: INK });
  for (const mark of marks) {
    const q = worksheet.layout.questions[mark.q];
    if (!q) throw new Error(`No question ${mark.q} in the worksheet`);
    if ("write" in mark) {
      const at = q.blank ?? (q.room ? { page: q.room.page, x: q.room.x + 20, y: q.room.y - 30, w: 0 } : null);
      if (!at) throw new Error(`Question ${mark.q} has nowhere to write`);
      pages[at.page - 1].drawText(mark.write, { x: at.x + 6, y: at.y + 3, size: 15, font: hand, color: INK });
      continue;
    }
    if ("draw" in mark) {
      const room = q.room!;
      const page = pages[room.page - 1];
      page.drawEllipse({ x: room.x + 150, y: room.y - room.h / 2, xScale: 90, yScale: 60, borderWidth: 1.6, borderColor: INK });
      page.drawEllipse({ x: room.x + 150, y: room.y - room.h / 2, xScale: 20, yScale: 16, borderWidth: 1.6, borderColor: INK });
      page.drawText("nucleus", { x: room.x + 260, y: room.y - room.h / 2, size: 13, font: hand, color: INK });
      continue;
    }
    const value = "circle" in mark ? mark.circle : "fill" in mark ? mark.fill : "tick" in mark ? mark.tick : "cross" in mark ? mark.cross : mark.dot;
    const a = q.options[value];
    if (!a) throw new Error(`Question ${mark.q} has no option ${value}`);
    const page = pages[a.page - 1];
    const cx = a.x + a.w / 2;
    const cy = a.y + 4;
    if ("circle" in mark) page.drawEllipse({ x: cx, y: cy, xScale: a.w / 2 + 9, yScale: 11, borderWidth: 1.4, borderColor: INK });
    if ("fill" in mark) page.drawCircle({ x: a.x - 10, y: cy, size: 5, color: INK });
    if ("tick" in mark) {
      // In the box, or just before the option's letter or word.
      const x = a.box ? a.x + 2 : a.x - 16;
      page.drawLine({ start: { x, y: cy }, end: { x: x + 5, y: cy - 6 }, thickness: 1.6, color: INK });
      page.drawLine({ start: { x: x + 5, y: cy - 6 }, end: { x: x + 14, y: cy + 10 }, thickness: 1.6, color: INK });
    }
    if ("cross" in mark) {
      page.drawLine({ start: { x: a.x - 6, y: cy - 8 }, end: { x: a.x + a.w + 6, y: cy + 10 }, thickness: 1.6, color: INK });
      page.drawLine({ start: { x: a.x - 6, y: cy + 10 }, end: { x: a.x + a.w + 6, y: cy - 8 }, thickness: 1.6, color: INK });
    }
    if ("dot" in mark) page.drawCircle({ x: a.x + a.w + 14, y: cy - 6, size: 0.5, color: rgb(0.45, 0.45, 0.45) });
  }
  const markedBytes = await marked.save();

  const out = await PDFDocument.create();
  const source = await PDFDocument.load(markedBytes);
  for (let i = 0; i < source.getPageCount(); i++) {
    const [embedded] = await out.embedPdf(source, [i]);
    const page = out.addPage(PAGE);
    placeWarped(page, embedded, o.warp ?? {});
  }
  return out.save();
}

function placeWarped(page: PDFPage, embedded: Parameters<PDFPage["drawPage"]>[0], w: ScanWarp): void {
  const s = w.scale ?? 1;
  const theta = ((w.rotate ?? 0) * Math.PI) / 180;
  const [cx, cy] = [PAGE[0] / 2, PAGE[1] / 2];
  // p' = s·R·p + o, and the centre should go to c + d: o = c + d − s·R·c.
  const x = cx + (w.dx ?? 0) - s * (Math.cos(theta) * cx - Math.sin(theta) * cy);
  const y = cy + (w.dy ?? 0) - s * (Math.sin(theta) * cx + Math.cos(theta) * cy);
  page.drawPage(embedded, { x, y, xScale: s, yScale: s, rotate: degrees(w.rotate ?? 0) });
}
