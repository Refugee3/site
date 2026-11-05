import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import type { NameMark } from "@/lib/ai/chatgpt/names";

// Covers what ChatGPT found (names, student IDs, emails, signatures) with white boxes labelled with the paper's anonymous ID,
// and builds the copy the grading AI reads. The pages are flattened to images, so nothing of the name survives underneath
// (a white rectangle drawn over a PDF page would leave its text layer readable).

/** Extra room around each box, in thousandths of the page: ChatGPT's boxes are approximate. */
export const COVER_MARGIN = 18;

export interface PageImage {
  /** PNG or JPEG bytes. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** A box in pixels, padded and kept on the page. */
export function markToPixels(m: NameMark, width: number, height: number, margin = COVER_MARGIN): { x: number; y: number; w: number; h: number } {
  const clamp = (v: number) => Math.min(1000, Math.max(0, v));
  const [x0, x1] = [clamp(Math.min(m.x_min, m.x_max) - margin), clamp(Math.max(m.x_min, m.x_max) + margin)];
  const [y0, y1] = [clamp(Math.min(m.y_min, m.y_max) - margin), clamp(Math.max(m.y_min, m.y_max) + margin)];
  const x = Math.floor((x0 / 1000) * width);
  const y = Math.floor((y0 / 1000) * height);
  return { x, y, w: Math.ceil((x1 / 1000) * width) - x, h: Math.ceil((y1 / 1000) * height) - y };
}

/** The pages with every mark covered and labelled "ID <anonId>", as JPEG images. */
export async function coverPages(pages: PageImage[], marks: NameMark[], anonId: string): Promise<PageImage[]> {
  const out: PageImage[] = [];
  for (const [index, page] of pages.entries()) {
    const image = await loadImage(Buffer.from(page.bytes));
    const canvas = createCanvas(page.width, page.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, page.width, page.height);
    for (const mark of marks.filter((m) => Math.round(m.page) === index + 1)) {
      const box = markToPixels(mark, page.width, page.height);
      if (box.w <= 0 || box.h <= 0) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = "#999999";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
      const size = Math.max(10, Math.min(box.h * 0.6, page.height * 0.025));
      ctx.fillStyle = "#000000";
      ctx.font = `${Math.round(size)}px sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(`ID ${anonId}`, box.x + 4, box.y + box.h / 2, Math.max(1, box.w - 8));
    }
    out.push({ bytes: new Uint8Array(await canvas.encode("jpeg", 88)), width: page.width, height: page.height });
  }
  return out;
}

/** A PDF of the page images, each page the size of a US Letter page's width (612 pt) at the image's proportions. */
export async function pagesToPdf(pages: PageImage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  for (const page of pages) {
    const jpg = await doc.embedJpg(page.bytes);
    const width = 612;
    const height = (page.height / page.width) * width;
    doc.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
  }
  return doc.save();
}

/** A random anonymous ID like "S-482913", not in `taken`. */
export function newAnonId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = `S-${String(Math.floor(100_000 + random() * 900_000))}`;
    if (!taken.has(id)) return id;
  }
}
