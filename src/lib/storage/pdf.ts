import { AsyncLocalStorage } from "node:async_hooks";
import zlib from "node:zlib";
import {
  PDFArray, PDFDocument, PDFName, PDFObjectStreamParser, PDFXRefStreamParser, type PDFImage, type PDFRawStream,
} from "pdf-lib";
import { AppError, isAppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ids";
import { decodeTextFile, isDocx, isTextFilename, readDocxText, renderTextPdf, SAVE_AS_MESSAGE } from "@/lib/storage/documents";

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

/** "image": a picture format the server can't embed (WebP, GIF, TIFF, AVIF…); browsers convert those to JPEG first. */
export type FileKind = "pdf" | "jpeg" | "png" | "heic" | "image" | "zip" | "ole" | "unknown";

// Readers accept junk before the header, so the PDF signature may sit anywhere in the first KiB.
const PDF_HEADER_WINDOW = 1024;
const HEIC_BRANDS = new Set(["ftypheic", "ftypheix", "ftypmif1"]);
const AVIF_BRANDS = new Set(["ftypavif", "ftypavis"]);
const OTHER_IMAGE_EXTENSIONS = /\.(bmp|webp|gif|tiff?|avif|heic|heif|jxl|svg)$/i;
// pdf-lib's ES5 build breaks instanceof checks on its error classes, so encryption is read from
// `doc.isEncrypted` after a load that ignores it.
const LOAD_OPTIONS = { ignoreEncryption: true, updateMetadata: false } as const;
const LETTER_PAGE = { width: 612, height: 792 } as const;
const MAX_FILENAME_LENGTH = 200;
const DEFAULT_FILENAME = "upload.pdf";
// Control characters, plus the bidi controls that can make a name display as something else.
const INVISIBLE_CONTROLS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

// Decompression limits. Uploads come from anyone with a share code, and a few KB of compressed data can
// expand to gigabytes on the main thread, so everything that is decoded while validating is capped first.
/** Bytes of object and cross-reference streams pdf-lib may inflate while loading one PDF. */
export const MAX_PDF_DECODED_BYTES = 64 * 1_048_576;
/** Pixels of all PNG parts of one upload together (pdf-lib decodes PNGs to raw pixels; JPEGs are embedded as is). */
export const MAX_PNG_PIXELS = 40_000_000;
/** PDF parsing and merging run at most this many at a time, so concurrent uploads cannot add up. */
const MAX_CONCURRENT_PDF_WORK = 2;

/** The file type by magic bytes only; extensions and MIME types are never trusted. */
export function sniffKind(b: Uint8Array): FileKind {
  if (latin1(b, 0, PDF_HEADER_WINDOW).includes("%PDF-")) return "pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (HEIC_BRANDS.has(latin1(b, 4, 12))) return "heic";
  if (AVIF_BRANDS.has(latin1(b, 4, 12)) || latin1(b, 0, 4) === "GIF8" || (latin1(b, 0, 4) === "RIFF" && latin1(b, 8, 12) === "WEBP")) {
    return "image";
  }
  if (latin1(b, 0, 4) === "II*\0" || latin1(b, 0, 4) === "MM\0*") return "image";
  if (latin1(b, 0, 4) === "PK\x03\x04") return "zip";
  // The compound-file container of old Office files (.doc, .xls, .ppt).
  if (latin1(b, 0, 8) === "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") return "ole";
  return "unknown";
}

function latin1(b: Uint8Array, start: number, end: number): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1", start, end);
}

/** Checks that the bytes are a readable, unencrypted PDF with 1..maxPages pages. */
export async function validatePdf(b: Uint8Array, o: { maxPages: number }): Promise<{ pageCount: number }> {
  return withPdfSlot(async () => {
    const { pageCount } = await openValidPdf(b, o.maxPages);
    return { pageCount };
  });
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
  // so both calls share one try.
  try {
    const budget: DecodeBudget = { remaining: MAX_PDF_DECODED_BYTES, refused: false };
    const doc = await decodeBudget.run(budget, () => PDFDocument.load(b, LOAD_OPTIONS));
    // An encrypted file's object streams cannot be inflated, so encryption is reported first.
    if (doc.isEncrypted) return { encrypted: true };
    if (budget.refused) throw invalidPdf();
    return { encrypted: false, doc, pageCount: doc.getPageCount() };
  } catch {
    throw invalidPdf();
  }
}

// ---------------------------------------------------------------------------------------------
// Decompression guard for PDFDocument.load
//
// While loading, pdf-lib fully inflates every object stream (/Type /ObjStm) and cross-reference stream
// (/Type /XRef) in JavaScript, before any page count can be checked. Both stream kinds are built through
// the parsers' static forStream(), so that is wrapped: the stream is first inflated natively with an
// output cap, and refused when it would exceed the file's budget. pdf-lib swallows the refusal (it
// treats the object as invalid), so the refusal is also recorded on the budget and checked after load.

interface DecodeBudget {
  remaining: number;
  refused: boolean;
}

// Process-wide like the guard itself: the guard installed by one copy of this module must see the
// budgets of every copy (route handlers and server actions may load it separately).
const decodeBudget = ((globalThis as unknown as Record<symbol, AsyncLocalStorage<DecodeBudget> | undefined>)[
  Symbol.for("pag.pdfDecodeBudget")
] ??= new AsyncLocalStorage<DecodeBudget>());
const GUARDED = Symbol.for("pag.pdfDecodeGuard");

function installDecodeGuard(): void {
  const objectStreams = PDFObjectStreamParser as unknown as Record<symbol, boolean>;
  if (objectStreams[GUARDED]) return;
  objectStreams[GUARDED] = true;
  const forObjectStream = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = (raw, shouldWaitForTick) => {
    chargeDecodedSize(raw);
    return forObjectStream(raw, shouldWaitForTick);
  };
  const forXRefStream = PDFXRefStreamParser.forStream;
  PDFXRefStreamParser.forStream = (raw) => {
    chargeDecodedSize(raw);
    return forXRefStream(raw);
  };
}

installDecodeGuard();

/** Throws (and marks the budget refused) unless the stream's decoded size fits the remaining budget. */
function chargeDecodedSize(raw: PDFRawStream): void {
  // Outside inspectPdf (no budget in context) each stream gets a budget of its own.
  const budget = decodeBudget.getStore() ?? { remaining: MAX_PDF_DECODED_BYTES, refused: false };
  try {
    budget.remaining -= decodedSize(raw, budget.remaining);
    if (budget.remaining < 0) throw new Error("decoded size over budget");
  } catch (e) {
    budget.refused = true;
    throw e;
  }
}

/** The stream's decoded size, inflating at most `limit` bytes. Only unfiltered and FlateDecode streams are accepted. */
function decodedSize(raw: PDFRawStream, limit: number): number {
  const filter = raw.dict.lookup(PDFName.of("Filter"));
  if (filter === undefined) return raw.contents.length;
  const flate = PDFName.of("FlateDecode");
  const isFlate = filter === flate || (filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === flate);
  // Other filters (LZW, run-length, chains) can expand just as much and are not used for these streams in practice.
  if (!isFlate) throw new Error("unsupported filter on an object or cross-reference stream");
  // Raw inflate after the 2-byte zlib header (pdf-lib checks the header itself), so a wrong Adler-32 trailer,
  // which pdf-lib ignores, does not refuse the file. Bytes after the end of the data are ignored, and a
  // truncated stream counts what it decodes to.
  return zlib.inflateRawSync(raw.contents.subarray(2), {
    maxOutputLength: Math.max(1, limit),
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  }).length;
}

// ---------------------------------------------------------------------------------------------
// Concurrency limit (process-wide: route handlers and server actions may load this module separately)

interface PdfSlots {
  active: number;
  waiting: Array<() => void>;
}

const PDF_SLOTS = Symbol.for("pag.pdfSlots");

function pdfSlots(): PdfSlots {
  const slots = globalThis as unknown as Record<symbol, PdfSlots | undefined>;
  return (slots[PDF_SLOTS] ??= { active: 0, waiting: [] });
}

async function withPdfSlot<T>(work: () => Promise<T>): Promise<T> {
  const slots = pdfSlots();
  if (slots.active < MAX_CONCURRENT_PDF_WORK) slots.active++;
  else await new Promise<void>((resolve) => slots.waiting.push(resolve)); // the releasing call hands its slot over
  try {
    return await work();
  } finally {
    const next = slots.waiting.shift();
    if (next) next();
    else slots.active--;
  }
}

/** Limits on what extractPageSets may cut, checked after each cut. */
export interface CutLimits {
  /** The largest one cut may be. */
  maxBytesPerSet?: number;
  /**
   * The most all cuts together may be. Each cut carries its own copy of every resource its pages use, so pages
   * sharing one large image or font multiply it by the number of cuts.
   */
  maxTotalBytes?: number;
}

/** extractPageSets stopped at the cut of `sets[index]`: that cut (`limit` "per_set") or the cuts so far ("total") were `bytes` long. */
export class CutTooLargeError extends Error {
  constructor(readonly limit: "per_set" | "total", readonly index: number, readonly bytes: number) {
    super(`Cutting page set ${index + 1} passed the ${limit === "per_set" ? "per-set" : "total"} limit (${bytes} bytes)`);
    this.name = "CutTooLargeError";
  }
}

/**
 * One new PDF per page set (1-based page numbers, in the given order), cut from a stored, already validated
 * PDF such as a scan. Same pages give the same bytes, also across separate loads, so the sha256 of a cut paper
 * is a stable dedupe key. Loading, checking and cutting share one PDF slot, and the parsed source is dropped
 * before returning: a parsed scan costs several times its file size, so no caller keeps one across an await.
 * Throws AppError("invalid_pdf") when the bytes can't be read, RangeError for a page outside the document, and
 * CutTooLargeError as soon as a cut passes `limits` (so memory stays bounded however the pages share resources).
 */
export async function extractPageSets(bytes: Uint8Array, sets: number[][], limits: CutLimits = {}): Promise<Uint8Array[]> {
  return withPdfSlot(async () => {
    const source = await loadStoredPdf(bytes);
    const pageCount = source.getPageCount();
    for (const set of sets) checkPageSet(set, pageCount);
    const cut: Uint8Array[] = [];
    let total = 0;
    for (const [index, set] of sets.entries()) {
      const pdf = await copyIntoNewPdf(source, set);
      total += pdf.byteLength;
      if (limits.maxBytesPerSet !== undefined && pdf.byteLength > limits.maxBytesPerSet) {
        throw new CutTooLargeError("per_set", index, pdf.byteLength);
      }
      if (limits.maxTotalBytes !== undefined && total > limits.maxTotalBytes) throw new CutTooLargeError("total", index, total);
      cut.push(pdf);
    }
    return cut;
  });
}

async function loadStoredPdf(b: Uint8Array): Promise<PDFDocument> {
  const pdf = await inspectPdf(b);
  if (pdf.encrypted) throw invalidPdf();
  return pdf.doc;
}

// pdf-lib itself throws an unhelpful TypeError for a page index it doesn't have.
function checkPageSet(pages: number[], pageCount: number): void {
  if (pages.length === 0) throw new RangeError("A page set must contain at least one page");
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new RangeError(`Page ${page} is outside the document's pages 1..${pageCount}`);
    }
  }
}

async function copyIntoNewPdf(source: PDFDocument, pages: number[]): Promise<Uint8Array> {
  try {
    // No metadata: a timestamp or producer string would make the bytes differ between runs.
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (const page of await doc.copyPages(source, pages.map((page) => page - 1))) doc.addPage(page);
    return await doc.save({ useObjectStreams: true });
  } catch {
    throw invalidPdf();
  }
}

/**
 * Turns the uploaded parts (PDFs, photos, Word and text files, in order) into the one PDF that is stored and
 * graded. A single PDF is kept byte for byte; anything else is merged into a new document.
 */
export async function buildSubmissionPdf(
  parts: UploadedFile[],
  o: { maxPages: number },
): Promise<{ bytes: Uint8Array; pageCount: number; contentSha256: string }> {
  if (parts.length === 0) throw new AppError("validation", "Choose at least one file to upload.");
  return withPdfSlot(() => mergeParts(parts, o));
}

async function mergeParts(
  parts: UploadedFile[],
  o: { maxPages: number },
): Promise<{ bytes: Uint8Array; pageCount: number; contentSha256: string }> {
  const prepared: PreparedPart[] = [];
  let pngPixels = 0;
  for (const [index, part] of parts.entries()) {
    const next = await namingPart(parts, index, () => preparePart(part, index, o.maxPages));
    if (next.kind === "png") {
      pngPixels += next.pixels;
      if (pngPixels > MAX_PNG_PIXELS) throw imageTooLarge(index);
    }
    prepared.push(next);
  }

  if (prepared.length === 1 && prepared[0].kind === "pdf") {
    const { bytes } = parts[0];
    return { bytes, pageCount: prepared[0].pageCount, contentSha256: sha256Hex(bytes) };
  }

  const pageCount = prepared.reduce((sum, part) => sum + part.pageCount, 0);
  if (pageCount > o.maxPages) throw tooManyPages(pageCount, o.maxPages);

  const doc = await PDFDocument.create();
  for (const [index, part] of prepared.entries()) {
    await namingPart(parts, index, () => (part.kind === "pdf" || part.kind === "text" ? appendPdf(doc, part.doc) : appendImage(doc, part)));
  }
  const bytes = await doc.save({ useObjectStreams: true });
  // Saved bytes embed timestamps, so duplicate detection hashes the inputs instead.
  const contentSha256 = sha256Hex(parts.map((part) => sha256Hex(part.bytes)).join(":"));
  return { bytes, pageCount, contentSha256 };
}

/**
 * Runs one part's step. When the upload has several parts, an error that does not already say which file
 * it is about is prefixed with "File N (name): ", so the student knows which one to remove or redo.
 */
async function namingPart<T>(parts: UploadedFile[], index: number, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    const label = `File ${index + 1}`;
    if (parts.length < 2 || !isAppError(e) || e.message.startsWith(`${label} `)) throw e;
    throw new AppError(e.code, `${label} (${sanitizeFilename(parts[index].filename)}): ${e.message}`, e.extra);
  }
}

type PreparedPart =
  | { kind: "pdf"; doc: PDFDocument; pageCount: number }
  /** A Word or text file rendered as text pages. */
  | { kind: "text"; doc: PDFDocument; pageCount: number }
  | { kind: "jpeg"; bytes: Uint8Array; index: number; pageCount: 1 }
  | { kind: "png"; bytes: Uint8Array; index: number; pageCount: 1; pixels: number };

/** Validates one part by its magic bytes, in upload order so the first bad file is the one reported. */
async function preparePart(part: UploadedFile, index: number, maxPages: number): Promise<PreparedPart> {
  const kind = sniffKind(part.bytes);
  switch (kind) {
    case "pdf":
      return { kind, ...(await openValidPdf(part.bytes, maxPages)) };
    case "jpeg":
      // pdf-lib embeds JPEG data as is, without decoding the pixels.
      return { kind, bytes: part.bytes, index, pageCount: 1 };
    case "png":
      // Checked before pdf-lib decodes the image: a tiny PNG can declare billions of pixels or inflate to gigabytes.
      return { kind, bytes: part.bytes, index, pageCount: 1, pixels: await checkPng(part.bytes, index) };
    case "heic":
      throw new AppError("unsupported_type", "HEIC photos are not supported. Use the Take photos button or export as JPEG.");
    case "image":
      throw unsupportedImage();
    case "zip":
      if (!isDocx(part.bytes)) throw new AppError("unsupported_type", SAVE_AS_MESSAGE);
      return { kind: "text", ...(await renderTextPdf(await readDocxText(part.bytes), maxPages)) };
    case "ole":
      throw new AppError("unsupported_type", SAVE_AS_MESSAGE);
    case "unknown":
      if (isTextFilename(part.filename)) return { kind: "text", ...(await renderTextPdf(decodeTextFile(part.bytes), maxPages)) };
      if (OTHER_IMAGE_EXTENSIONS.test(part.filename)) throw unsupportedImage();
      throw new AppError("unsupported_type", `${SAVE_AS_MESSAGE} ${ACCEPTED_MESSAGE}`);
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
    throw unreadablePhoto(photo.index);
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

// Channels per PNG color type (grayscale, RGB, palette, gray + alpha, RGBA).
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Animation chunks: pdf-lib decodes every frame (at sizes of the file's choosing) before refusing animated PNGs.
const APNG_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);

/**
 * Checks a PNG before pdf-lib decodes it and returns its pixel count. The image header (which must be
 * the first chunk, and the only one) bounds the pixels, and the image data must not inflate past what
 * those pixels need: pdf-lib's decoder writes into a buffer of that size but keeps decoding, in
 * JavaScript, whatever the data expands to.
 */
async function checkPng(b: Uint8Array, index: number): Promise<number> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 33 || view.getUint32(8) !== 13 || latin1(b, 12, 16) !== "IHDR") throw unreadablePhoto(index);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const channels = PNG_CHANNELS[b[25]];
  if (width === 0 || height === 0 || channels === undefined) throw unreadablePhoto(index);
  const pixels = width * height;
  if (pixels > MAX_PNG_PIXELS) throw imageTooLarge(index);

  const data: Uint8Array[] = [];
  for (let offset = 33; offset + 8 <= b.length;) {
    const end = offset + 8 + view.getUint32(offset);
    const type = latin1(b, offset + 4, offset + 8);
    if (type === "IHDR" || APNG_CHUNKS.has(type)) throw unreadablePhoto(index);
    if (type === "IDAT") data.push(b.subarray(offset + 8, Math.min(end, b.length)));
    if (type === "IEND") break;
    offset = end + 4; // the chunk's CRC
  }
  const rowBytes = Math.ceil((width * channels * b[24]) / 8) + 1;
  // Generous: interlaced images need a little more than one filter byte per row.
  if (!(await inflatesWithin(Buffer.concat(data), 2 * rowBytes * height + 1024))) throw unreadablePhoto(index);
  return pixels;
}

/**
 * Whether zlib data inflates to at most `limit` bytes, counted natively off the main thread without
 * keeping the output. Data that is not valid deflate also fails: a more lenient decoder could keep
 * expanding it. Like pdf-lib, this skips the zlib header and ignores the checksum and anything after
 * the end of the data; truncated data counts what it decodes to.
 */
function inflatesWithin(data: Uint8Array, limit: number): Promise<boolean> {
  return new Promise((resolve) => {
    const inflate = zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH, chunkSize: 256 * 1024 });
    let total = 0;
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    inflate.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= limit) return;
      settle(false);
      inflate.destroy();
    });
    inflate.on("end", () => settle(true));
    inflate.on("error", () => settle(false));
    inflate.end(data.subarray(2));
  });
}

const ACCEPTED_MESSAGE = "PDFs, photos, Word (.docx) and text files are accepted.";

function unsupportedImage(): AppError {
  return new AppError("unsupported_type", "This kind of image can't be read here. Pick it again on the upload page so your browser converts it, or export it as JPEG or PDF.");
}

function unreadablePhoto(index: number): AppError {
  return new AppError("validation", `File ${index + 1} could not be read as a photo. Retake it or upload a PDF.`);
}

function imageTooLarge(index: number): AppError {
  return new AppError("validation", `File ${index + 1} is too large an image. Use the Take photos button, or upload it as a JPEG or PDF.`);
}

function invalidPdf(): AppError {
  return new AppError("invalid_pdf", "This PDF could not be read. Export or scan it again and retry.");
}

function tooManyPages(pageCount: number, maxPages: number): AppError {
  return new AppError("too_many_pages", `This upload has ${pageCount} pages; the limit is ${maxPages}.`);
}

/** The display name of an upload: the first file's name, plus how many more were merged into it. */
export function uploadName(files: UploadedFile[]): string {
  const first = sanitizeFilename(files[0]?.filename ?? "");
  return files.length > 1 ? `${first} + ${files.length - 1} more` : first;
}

/** A display-only name: the basename without control characters, at most 200 characters. */
export function sanitizeFilename(name: string): string {
  const basename = name.split(/[/\\]/).pop() ?? "";
  const cleaned = basename.replace(INVISIBLE_CONTROLS, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return DEFAULT_FILENAME;
  return Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("");
}
