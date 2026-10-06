import { PDFDocument, type PDFImage } from "pdf-lib";
import { AppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ids";

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

export type FileKind = "pdf" | "jpeg" | "png" | "heic" | "unknown";

// Readers accept junk before the header, so the PDF signature may sit anywhere in the first KiB.
const PDF_HEADER_WINDOW = 1024;
const HEIC_BRANDS = new Set(["ftypheic", "ftypheix", "ftypmif1"]);
// pdf-lib's ES5 build breaks instanceof checks on its error classes, so encryption is read from
// `doc.isEncrypted` after a load that ignores it (§0 fact 4).
const LOAD_OPTIONS = { ignoreEncryption: true, updateMetadata: false } as const;
const LETTER_PAGE = { width: 612, height: 792 } as const;
const MAX_FILENAME_LENGTH = 200;
const DEFAULT_FILENAME = "upload.pdf";
// Control characters, plus the bidi controls that can make a name display as something else.
const INVISIBLE_CONTROLS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** The file type by magic bytes only; extensions and MIME types are never trusted. */
export function sniffKind(b: Uint8Array): FileKind {
  if (latin1(b, 0, PDF_HEADER_WINDOW).includes("%PDF-")) return "pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (HEIC_BRANDS.has(latin1(b, 4, 12))) return "heic";
  return "unknown";
}

function latin1(b: Uint8Array, start: number, end: number): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1", start, end);
}

/** Checks that the bytes are a readable, unencrypted PDF with 1..maxPages pages. */
export async function validatePdf(b: Uint8Array, o: { maxPages: number }): Promise<{ pageCount: number }> {
  const { pageCount } = await openValidPdf(b, o.maxPages);
  return { pageCount };
}

async function openValidPdf(b: Uint8Array, maxPages: number): Promise<{ doc: PDFDocument; pageCount: number }> {
  if (sniffKind(b) !== "pdf") throw new AppError("not_pdf", "This file is not a PDF.");
  const pdf = await inspectPdf(b);
  if (pdf.encrypted) throw new AppError("encrypted_pdf", "This PDF is password-protected. Remove the password protection and try again.");
  if (pdf.pageCount === 0) throw new AppError("empty_pdf", "This PDF has no pages.");
  if (pdf.pageCount > maxPages) throw tooManyPages(pdf.pageCount, maxPages);
  return pdf;
}

async function inspectPdf(b: Uint8Array): Promise<{ encrypted: true } | { encrypted: false; doc: PDFDocument; pageCount: number }> {
  // pdf-lib loads some garbage that starts with %PDF- and only throws from getPageCount(),
  // so both calls share one try (§0 fact 4).
  try {
    const doc = await PDFDocument.load(b, LOAD_OPTIONS);
    if (doc.isEncrypted) return { encrypted: true };
    return { encrypted: false, doc, pageCount: doc.getPageCount() };
  } catch {
    throw invalidPdf();
  }
}

/**
 * Turns the uploaded parts (PDFs and photos, in order) into the one PDF that is stored and graded.
 * A single PDF is kept byte for byte; anything else is merged into a new document.
 */
export async function buildSubmissionPdf(
  parts: UploadedFile[],
  o: { maxPages: number },
): Promise<{ bytes: Uint8Array; pageCount: number; contentSha256: string }> {
  if (parts.length === 0) throw new AppError("validation", "Choose at least one file to upload.");
  const prepared: PreparedPart[] = [];
  for (const [index, part] of parts.entries()) prepared.push(await preparePart(part, index, o.maxPages));

  if (prepared.length === 1 && prepared[0].kind === "pdf") {
    const { bytes } = parts[0];
    return { bytes, pageCount: prepared[0].pageCount, contentSha256: sha256Hex(bytes) };
  }

  const pageCount = prepared.reduce((sum, part) => sum + part.pageCount, 0);
  if (pageCount > o.maxPages) throw tooManyPages(pageCount, o.maxPages);

  const doc = await PDFDocument.create();
  for (const part of prepared) {
    if (part.kind === "pdf") await appendPdf(doc, part.doc);
    else await appendImage(doc, part);
  }
  const bytes = await doc.save({ useObjectStreams: true });
  // Saved bytes embed timestamps, so duplicate detection hashes the inputs instead.
  const contentSha256 = sha256Hex(parts.map((part) => sha256Hex(part.bytes)).join(":"));
  return { bytes, pageCount, contentSha256 };
}

type PreparedPart =
  | { kind: "pdf"; doc: PDFDocument; pageCount: number }
  | { kind: "jpeg" | "png"; bytes: Uint8Array; index: number; pageCount: 1 };

/** Validates one part by its magic bytes, in upload order so the first bad file is the one reported. */
async function preparePart(part: UploadedFile, index: number, maxPages: number): Promise<PreparedPart> {
  const kind = sniffKind(part.bytes);
  switch (kind) {
    case "pdf":
      return { kind, ...(await openValidPdf(part.bytes, maxPages)) };
    case "jpeg":
    case "png":
      return { kind, bytes: part.bytes, index, pageCount: 1 };
    case "heic":
      throw new AppError("unsupported_type", "HEIC photos are not supported. Use the Take photos button or export as JPEG.");
    case "unknown":
      throw new AppError("unsupported_type", "Only PDF, JPEG and PNG files can be uploaded.");
  }
}

async function appendPdf(doc: PDFDocument, source: PDFDocument): Promise<void> {
  try {
    const pages = await doc.copyPages(source, source.getPageIndices());
    for (const page of pages) doc.addPage(page);
  } catch {
    throw invalidPdf();
  }
}

/** Adds a photo as its own letter-size page, scaled to fit and centered. */
async function appendImage(doc: PDFDocument, photo: { kind: "jpeg" | "png"; bytes: Uint8Array; index: number }): Promise<void> {
  let image: PDFImage;
  try {
    image = photo.kind === "jpeg" ? await doc.embedJpg(photo.bytes) : await doc.embedPng(photo.bytes);
  } catch {
    throw new AppError("validation", `File ${photo.index + 1} could not be read as a photo. Retake it or upload a PDF.`);
  }
  const scale = Math.min(LETTER_PAGE.width / image.width, LETTER_PAGE.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  doc.addPage([LETTER_PAGE.width, LETTER_PAGE.height]).drawImage(image, {
    x: (LETTER_PAGE.width - width) / 2,
    y: (LETTER_PAGE.height - height) / 2,
    width,
    height,
  });
}

function invalidPdf(): AppError {
  return new AppError("invalid_pdf", "This PDF could not be read. Export or scan it again and retry.");
}

function tooManyPages(pageCount: number, maxPages: number): AppError {
  return new AppError("too_many_pages", `This upload has ${pageCount} pages; the limit is ${maxPages}.`);
}

/** A display-only name: the basename without control characters, at most 200 characters. */
export function sanitizeFilename(name: string): string {
  const basename = name.split(/[/\\]/).pop() ?? "";
  const cleaned = basename.replace(INVISIBLE_CONTROLS, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return DEFAULT_FILENAME;
  return Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("");
}
