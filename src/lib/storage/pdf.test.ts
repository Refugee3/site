import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { isAppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ids";
import { buildSubmissionPdf, sanitizeFilename, sniffKind, validatePdf, type UploadedFile } from "@/lib/storage/pdf";
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

  it("tells HEIC uploaders what to do", async () => {
    await expect(buildSubmissionPdf([file(HEIC)], OPTS)).rejects.toThrow("Use the Take photos button or export as JPEG");
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
