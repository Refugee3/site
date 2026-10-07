import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ids";
import {
  buildSubmissionPdf, MAX_PDF_DECODED_BYTES, sanitizeFilename, sniffKind, validatePdf, type UploadedFile,
} from "@/lib/storage/pdf";
import { ENCRYPTED_PDF, makePdf, TINY_JPEG, TINY_PNG } from "@/test/helpers";

const ascii = (s: string) => new TextEncoder().encode(s);
const file = (bytes: Uint8Array, filename = "part"): UploadedFile => ({ filename, bytes });
const HEIC = Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftypheic"), 0, 0, 0, 0]);
const OPTS = { maxPages: 40 };

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (isAppError(e)) return e.code;
    throw e;
  }
  throw new Error("expected an AppError");
}

/** A PDF whose pages have distinctive sizes, so merge order is visible. */
async function sizedPdf(sizes: Array<[number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const size of sizes) doc.addPage(size);
  return doc.save({ addDefaultPage: false });
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * An all-black 1-bit grayscale PNG (a huge one compresses to a few KB). `rawBytes` overrides how much
 * the image data inflates to, and `extra` adds chunks before the data.
 */
function blackPng(width: number, height: number, o: { rawBytes?: number; extra?: Buffer[] } = {}): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // grayscale
  const rows = Buffer.alloc(o.rawBytes ?? (Math.ceil(width / 8) + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...(o.extra ?? []),
    pngChunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A one-page PDF whose page object lives in object streams; each entry of `inflatedSizes` is one more
 * object stream padded so that it inflates to that many bytes.
 */
function pdfWithObjectStreams(inflatedSizes: number[]): Uint8Array {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.5\n", "latin1")];
  const offsets = new Map<number, number>();
  let length = chunks[0].length;
  const add = (data: Buffer | string) => {
    const chunk = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    chunks.push(chunk);
    length += chunk.length;
  };
  const object = (n: number, ...parts: Array<Buffer | string>) => {
    offsets.set(n, length);
    add(`${n} 0 obj\n`);
    for (const part of parts) add(part);
    add("\nendobj\n");
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  inflatedSizes.forEach((size, index) => {
    const contained = 3 + index * 2; // the page in the first stream, then filler dictionaries
    const prefix = `${contained} 0 `;
    const body = index === 0 ? "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>" : "<< >>";
    const decoded = Buffer.alloc(Math.max(size, prefix.length + body.length), 0x20);
    decoded.write(prefix + body, "latin1");
    const data = zlib.deflateSync(decoded, { level: 9 });
    object(4 + index * 2, `<< /Type /ObjStm /N 1 /First ${prefix.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, data, "\nendstream");
  });
  const size = 4 + inflatedSizes.length * 2;
  const xrefAt = length;
  const entries = Array.from({ length: size }, (_, n) =>
    offsets.has(n) ? `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n");
  add(`xref\n0 ${size}\n${entries.join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

async function pageSizes(bytes: Uint8Array): Promise<Array<[number, number]>> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);
}

describe("sniffKind", () => {
  it("recognizes files by magic bytes", async () => {
    expect(sniffKind(await makePdf(1))).toBe("pdf");
    expect(sniffKind(TINY_JPEG)).toBe("jpeg");
    expect(sniffKind(TINY_PNG)).toBe("png");
    expect(sniffKind(HEIC)).toBe("heic");
    expect(sniffKind(Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftypmif1")]))).toBe("heic");
    expect(sniffKind(ascii("hello world"))).toBe("unknown");
    expect(sniffKind(new Uint8Array())).toBe("unknown");
  });

  it("finds a PDF header within the first KiB only", () => {
    expect(sniffKind(ascii(`${" ".repeat(1000)}%PDF-1.7`))).toBe("pdf");
    expect(sniffKind(ascii(`${" ".repeat(1024)}%PDF-1.7`))).toBe("unknown");
  });

  it("reads a view into a larger buffer from its own offset", () => {
    const backing = new Uint8Array(16);
    backing.set(TINY_JPEG.subarray(0, 4), 8);
    expect(sniffKind(backing.subarray(8))).toBe("jpeg");
  });
});

describe("validatePdf", () => {
  it("returns the page count of a valid PDF", async () => {
    expect(await validatePdf(await makePdf(3), OPTS)).toEqual({ pageCount: 3 });
  });

  it.each<[string, () => Promise<Uint8Array> | Uint8Array, string]>([
    ["a JPEG", () => TINY_JPEG, "not_pdf"],
    ["an encrypted PDF", () => ENCRYPTED_PDF, "encrypted_pdf"],
    ["garbage after a PDF header", () => ascii("%PDF-1.4 garbage"), "invalid_pdf"],
    ["a truncated PDF", async () => (await makePdf(2)).subarray(0, 200), "invalid_pdf"],
    ["a PDF without pages", () => sizedPdf([]), "empty_pdf"],
  ])("rejects %s", async (_name, bytes, code) => {
    expect(await errorCode(validatePdf(await bytes(), OPTS))).toBe(code);
  });

  it("enforces the page limit", async () => {
    const pdf = await makePdf(3);
    expect(await validatePdf(pdf, { maxPages: 3 })).toEqual({ pageCount: 3 });
    expect(await errorCode(validatePdf(pdf, { maxPages: 2 }))).toBe("too_many_pages");
  });

  it("asks for the password protection to be removed", async () => {
    await expect(validatePdf(ENCRYPTED_PDF, OPTS)).rejects.toThrow("Remove the password protection and try again");
  });

  it("reads object streams within the decompression budget", async () => {
    expect(await validatePdf(pdfWithObjectStreams([1000]), OPTS)).toEqual({ pageCount: 1 });
  });

  it("refuses a small file whose object stream would inflate past the budget, without inflating it", async () => {
    const bomb = pdfWithObjectStreams([MAX_PDF_DECODED_BYTES + 1_000_000]);
    expect(bomb.length).toBeLessThan(200_000);
    const started = performance.now();
    expect(await errorCode(validatePdf(bomb, OPTS))).toBe("invalid_pdf");
    expect(await errorCode(buildSubmissionPdf([file(TINY_JPEG), file(bomb)], OPTS))).toBe("invalid_pdf");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("counts the budget across all object streams of a file", async () => {
    const half = Math.ceil(MAX_PDF_DECODED_BYTES / 2) + 1000;
    expect(await errorCode(validatePdf(pdfWithObjectStreams([1000, half, half]), OPTS))).toBe("invalid_pdf");
  });

  it("lets concurrent validations queue up and all finish, including failed ones", async () => {
    const pdf = await makePdf(1);
    const results = await Promise.allSettled([
      ...Array.from({ length: 5 }, () => validatePdf(pdf, OPTS)),
      validatePdf(ascii("%PDF-1.4 garbage"), OPTS),
      buildSubmissionPdf([file(TINY_JPEG), file(pdf)], OPTS),
    ]);
    expect(results.map((r) => r.status)).toEqual([...Array(5).fill("fulfilled"), "rejected", "fulfilled"]);
    expect(await validatePdf(pdf, OPTS)).toEqual({ pageCount: 1 });
  });
});

describe("buildSubmissionPdf", () => {
  it("keeps a single PDF byte for byte", async () => {
    const pdf = await makePdf(2);
    const result = await buildSubmissionPdf([file(pdf)], OPTS);
    expect(result.bytes).toBe(pdf);
    expect(result).toMatchObject({ pageCount: 2, contentSha256: sha256Hex(pdf) });
  });

  it("turns each photo into a letter-size page", async () => {
    const result = await buildSubmissionPdf([file(TINY_JPEG), file(TINY_PNG)], OPTS);
    expect(result.pageCount).toBe(2);
    expect(sniffKind(result.bytes)).toBe("pdf");
    expect(await pageSizes(result.bytes)).toEqual([[612, 792], [612, 792]]);
    expect(await validatePdf(result.bytes, OPTS)).toEqual({ pageCount: 2 });
  });

  it("merges PDFs and photos in upload order", async () => {
    const pdf = await sizedPdf([[300, 400], [500, 500]]);
    const photoFirst = await buildSubmissionPdf([file(TINY_JPEG), file(pdf)], OPTS);
    expect(photoFirst.pageCount).toBe(3);
    expect(await pageSizes(photoFirst.bytes)).toEqual([[612, 792], [300, 400], [500, 500]]);

    const pdfFirst = await buildSubmissionPdf([file(pdf), file(TINY_JPEG)], OPTS);
    expect(await pageSizes(pdfFirst.bytes)).toEqual([[300, 400], [500, 500], [612, 792]]);
  });

  it("hashes the parts, so the same parts give the same hash and a different order does not", async () => {
    const pdf = await makePdf(1);
    const parts = [file(pdf), file(TINY_JPEG)];
    const first = await buildSubmissionPdf(parts, OPTS);
    const second = await buildSubmissionPdf([file(pdf, "renamed.pdf"), file(TINY_JPEG, "other.jpg")], OPTS);
    expect(first.contentSha256).toBe(second.contentSha256);
    expect(first.contentSha256).toBe(sha256Hex(`${sha256Hex(pdf)}:${sha256Hex(TINY_JPEG)}`));
    expect((await buildSubmissionPdf([file(TINY_JPEG), file(pdf)], OPTS)).contentSha256).not.toBe(first.contentSha256);
  });

  it("limits the merged page total", async () => {
    const parts = [file(await makePdf(2)), file(TINY_JPEG)];
    expect((await buildSubmissionPdf(parts, { maxPages: 3 })).pageCount).toBe(3);
    expect(await errorCode(buildSubmissionPdf(parts, { maxPages: 2 }))).toBe("too_many_pages");
  });

  it.each<[string, () => Promise<UploadedFile[]>, string]>([
    ["no parts", async () => [], "validation"],
    ["a HEIC photo", async () => [file(TINY_JPEG), file(HEIC)], "unsupported_type"],
    ["an unknown file", async () => [file(ascii("plain text"))], "unsupported_type"],
    ["an encrypted PDF among photos", async () => [file(TINY_JPEG), file(ENCRYPTED_PDF)], "encrypted_pdf"],
    ["a broken PDF among photos", async () => [file(TINY_PNG), file(ascii("%PDF-1.4 garbage"))], "invalid_pdf"],
    ["a single oversized PDF", async () => [file(await makePdf(3))], "too_many_pages"],
    ["a corrupt photo", async () => [file(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01]))], "validation"],
  ])("rejects %s", async (_name, parts, code) => {
    expect(await errorCode(buildSubmissionPdf(await parts(), { maxPages: 2 }))).toBe(code);
  });

  it("refuses a PNG that declares too many pixels before decoding it", async () => {
    const bomb = blackPng(20_000, 20_000);
    expect(bomb.length).toBeLessThan(100_000);
    const started = performance.now();
    await expect(buildSubmissionPdf([file(TINY_JPEG), file(bomb)], OPTS)).rejects.toThrow("File 2 is too large an image");
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("limits the PNG pixels of one upload together", async () => {
    const photo = blackPng(5000, 5000); // 25 MP: fine alone, too much twice
    expect(await errorCode(buildSubmissionPdf([file(photo), file(photo)], OPTS))).toBe("validation");
    await expect(buildSubmissionPdf([file(photo), file(TINY_JPEG), file(photo)], OPTS)).rejects.toThrow("File 3 is too large");
  });

  it("accepts a valid PNG made the same way", async () => {
    expect((await buildSubmissionPdf([file(blackPng(300, 200))], OPTS)).pageCount).toBe(1);
  });

  it("refuses a small PNG whose image data inflates far past its size, without decoding it", async () => {
    const bomb = blackPng(10, 10, { rawBytes: 200_000_000 });
    expect(bomb.length).toBeLessThan(300_000);
    const started = performance.now();
    await expect(buildSubmissionPdf([file(bomb)], OPTS)).rejects.toThrow("File 1 could not be read as a photo");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses animated PNGs and a second image header", async () => {
    const actl = pngChunk("acTL", Buffer.alloc(8));
    const ihdr = pngChunk("IHDR", Buffer.from([0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20, 1, 0, 0, 0, 0]));
    for (const extra of [[actl], [ihdr]]) {
      await expect(buildSubmissionPdf([file(blackPng(10, 10, { extra }))], OPTS)).rejects.toThrow("File 1 could not be read as a photo");
    }
  });

  it("refuses a PNG without a header chunk", async () => {
    await expect(buildSubmissionPdf([file(TINY_PNG.subarray(0, 20))], OPTS)).rejects.toThrow("File 1 could not be read as a photo");
  });

  it("tells HEIC uploaders what to do", async () => {
    await expect(buildSubmissionPdf([file(HEIC)], OPTS)).rejects.toThrow("Use the Take photos button or export as JPEG");
  });

  it("says which file of several is the problem", async () => {
    const rejection = async (parts: UploadedFile[]) => {
      const error = await buildSubmissionPdf(parts, OPTS).then(() => null, (e: unknown) => e);
      if (!isAppError(error)) throw new Error("expected an AppError");
      return { code: error.code, message: error.message };
    };
    const good = await makePdf(1);
    expect(await rejection([file(good, "a.pdf"), file(ascii("%PDF-1.7\ngarbage"), "broken.pdf"), file(good, "c.pdf")])).toEqual({
      code: "invalid_pdf",
      message: "File 2 (broken.pdf): This PDF could not be read. Export or scan it again and retry.",
    });
    expect(await rejection([file(TINY_JPEG, "photo1.jpg"), file(ascii("hello"), "fake.pdf")])).toEqual({
      code: "unsupported_type",
      message: "File 2 (fake.pdf): Only PDF, JPEG and PNG files can be uploaded.",
    });
    expect((await rejection([file(TINY_JPEG), file(ENCRYPTED_PDF, "dir/locked‮.pdf")])).message).toMatch(
      /^File 2 \(locked\.pdf\): This PDF is password-protected/,
    );
    // Messages that already name the file are kept as they are.
    expect((await rejection([file(TINY_JPEG), file(TINY_PNG.subarray(0, 20), "cut.png")])).message).toBe(
      "File 2 could not be read as a photo. Retake it or upload a PDF.",
    );
  });

  it("keeps the message of a single bad file as it is", async () => {
    await expect(buildSubmissionPdf([file(ascii("%PDF-1.7\ngarbage"), "broken.pdf")], OPTS)).rejects.toThrow(
      /^This PDF could not be read\./,
    );
    await expect(buildSubmissionPdf([file(ascii("hello"), "fake.pdf")], OPTS)).rejects.toThrow(
      /^Only PDF, JPEG and PNG files can be uploaded\.$/,
    );
  });
});

describe("sanitizeFilename", () => {
  it.each<[string, string]>([
    ["homework.pdf", "homework.pdf"],
    ["C:\\Users\\maria\\Desktop\\hw 3.pdf", "hw 3.pdf"],
    ["../../etc/passwd", "passwd"],
    ["bad\u0000name\u001f\u007f.pdf", "badname.pdf"],
    ["  spaced.pdf  ", "spaced.pdf"],
    ["", "upload.pdf"],
    ["dir/", "upload.pdf"],
    ["..", "upload.pdf"],
    ["\u0001\u0002", "upload.pdf"],
    ["photo\u202egpj.exe", "photogpj.exe"],
  ])("%j → %j", (name, expected) => {
    expect(sanitizeFilename(name)).toBe(expected);
  });

  it("caps the name at 200 characters without splitting emoji", () => {
    const name = sanitizeFilename(`${"😀".repeat(250)}.pdf`);
    expect(Array.from(name)).toHaveLength(200);
    expect(name).toBe("😀".repeat(200));
  });
});
