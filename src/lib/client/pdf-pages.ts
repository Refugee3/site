import { isPdfFile } from "./upload-files";

/**
 * The page count of a PDF the teacher picked, read in the browser (pdf-lib, loaded only when needed); null for a file that
 * isn't a PDF or can't be read here (the server still checks every upload).
 */
export async function countPdfPages(file: File): Promise<number | null> {
  if (!isPdfFile(file)) return null;
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}
