import zlib from "node:zlib";
import mammoth from "mammoth";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { AppError } from "@/lib/errors";

// Word (.docx) and plain-text uploads, turned into simple text pages so the rest of the pipeline only sees PDFs.

/** Bytes all entries of one .docx may inflate to together; checked natively before mammoth inflates them in JavaScript. */
export const MAX_DOCX_DECODED_BYTES = 64 * 1_048_576;
const MAX_ZIP_ENTRIES = 5_000;
const TEXT_EXTENSIONS = /\.(txt|text|md|markdown|csv|tsv)$/i;
const PAGE = { width: 612, height: 792, margin: 54, fontSize: 11, lineHeight: 15 } as const;
const REPLACEMENT = "?";

export const SAVE_AS_MESSAGE = "This file type can't be read here. Save it as PDF or .docx first, then upload it again.";

export function isTextFilename(name: string): boolean {
  return TEXT_EXTENSIONS.test(name);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** The central directory of a zip file, or null when it can't be read (zip64 archives included). */
function zipEntries(b: Uint8Array): ZipEntry[] | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // The end-of-central-directory record is 22 bytes plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count > MAX_ZIP_ENTRIES) return null;
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > b.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const entry = {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
      name: Buffer.from(b.buffer, b.byteOffset + offset + 46, Math.min(nameLength, b.length - offset - 46)).toString("utf8"),
    };
    if (entry.compressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) return null;
    entries.push(entry);
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

/** Whether the bytes (already known to start like a zip) are a Word document. */
export function isDocx(b: Uint8Array): boolean {
  return zipEntries(b)?.some((entry) => entry.name === "word/document.xml") ?? false;
}

/**
 * Throws unless every entry inflates within MAX_DOCX_DECODED_BYTES in total: a few KB of zip can expand to
 * gigabytes, and mammoth would inflate it all on the main thread.
 */
function checkZipSize(b: Uint8Array, entries: ZipEntry[]): void {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let remaining = MAX_DOCX_DECODED_BYTES;
  for (const entry of entries) {
    const local = entry.localHeaderOffset;
    if (local + 30 > b.length || view.getUint32(local, true) !== 0x04034b50) throw unreadableDocx();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = b.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) remaining -= data.length;
    else if (entry.method === 8) {
      try {
        remaining -= zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) }).length;
      } catch {
        throw unreadableDocx();
      }
    } else throw unreadableDocx();
    if (remaining < 0) throw unreadableDocx();
  }
}

/** The text of a .docx, paragraph by paragraph. */
export async function readDocxText(b: Uint8Array): Promise<string> {
  const entries = zipEntries(b);
  if (!entries) throw unreadableDocx();
  checkZipSize(b, entries);
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(b.buffer, b.byteOffset, b.byteLength) });
    return value;
  } catch {
    throw unreadableDocx();
  }
}

/** A text file's contents: UTF-8 (with or without BOM), else Windows-1252. Binary data is refused. */
export function decodeTextFile(b: Uint8Array): string {
  if (b.includes(0)) throw new AppError("unsupported_type", SAVE_AS_MESSAGE);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

/** Renders text as letter-size pages in Helvetica, wrapped to the margins. Throws past `maxPages`. */
export async function renderTextPdf(text: string, maxPages: number): Promise<{ doc: PDFDocument; pageCount: number }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const encodable = new Set(font.getCharacterSet());
  const width = (s: string) => font.widthOfTextAtSize(s, PAGE.fontSize);
  const linesPerPage = Math.floor((PAGE.height - 2 * PAGE.margin) / PAGE.lineHeight);
  const maxLines = maxPages * linesPerPage;
  const lines = wrapLines(cleanText(text, encodable), width, PAGE.width - 2 * PAGE.margin, maxLines + 1);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length === 0) throw new AppError("empty_pdf", "This file has no text to grade.");
  const pageCount = Math.ceil(lines.length / linesPerPage);
  if (lines.length > maxLines) {
    throw new AppError("too_many_pages", `This file is longer than the limit of ${maxPages} pages.`);
  }
  for (let start = 0; start < lines.length; start += linesPerPage) {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    lines.slice(start, start + linesPerPage).forEach((line, i) => {
      if (line) page.drawText(line, { x: PAGE.margin, y: PAGE.height - PAGE.margin - (i + 1) * PAGE.lineHeight + 4, size: PAGE.fontSize, font });
    });
  }
  return { doc, pageCount };
}

/** Normalizes line breaks and tabs, drops control characters, and swaps characters the font can't draw. */
function cleanText(text: string, encodable: Set<number>): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  let out = "";
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== "\n") continue; // other control characters
    if (ch === "\n" || encodable.has(code)) {
      out += ch;
      continue;
    }
    // Accented letters outside the font's set keep their base letter ("ő" → "o").
    const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out += base && [...base].every((c) => encodable.has(c.codePointAt(0) ?? 0)) ? base : REPLACEMENT;
  }
  return out;
}

/** Word-wraps each line to `maxWidth`, splitting words longer than a line; stops after `limit` lines. */
function wrapLines(text: string, width: (s: string) => number, maxWidth: number, limit: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (lines.length >= limit) break;
    let line = "";
    for (const word of paragraph.split(/(?<= )/)) {
      if (width(line + word) <= maxWidth) {
        line += word;
        continue;
      }
      if (line) lines.push(line.trimEnd());
      line = "";
      for (const ch of word) {
        if (line && width(line + ch) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
      if (lines.length >= limit) break;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function unreadableDocx(): AppError {
  return new AppError("validation", "This Word file could not be read. Save it again as .docx or PDF and retry.");
}
