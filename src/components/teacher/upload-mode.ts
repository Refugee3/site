// What a drop of students' work on the workspace becomes: one paper per file, or one scan of the whole class graded in one pass.

export type PaperUploadMode = "per_student" | "packet";

/** One PDF this much longer than the answer key is taken for the whole class's papers scanned together. */
export const PACKET_FACTOR = 1.5;

export interface UploadModeInput {
  fileCount: number;
  /** The single file is a PDF (only then are its pages counted). */
  isPdf: boolean;
  /** The PDF's pages, or null when they couldn't be counted. */
  pageCount: number | null;
  /** The answer key's pages (the likely length of one student's paper), or null when unknown. */
  keyPageCount: number | null;
}

export interface UploadModeGuess {
  mode: PaperUploadMode;
  /** One short line on why, for the teacher. */
  why: string;
}

function pages(n: number): string {
  return `${n} ${n === 1 ? "page" : "pages"}`;
}

/**
 * Several files are one paper per student. A single PDF more than PACKET_FACTOR × the key's pages long is the whole class in
 * one scan; anything else (a photo, a Word file, a short PDF, or a key of unknown length) is one student's paper. The teacher
 * can switch with one click before the upload starts.
 */
export function detectUploadMode(i: UploadModeInput): UploadModeGuess {
  if (i.fileCount !== 1) return { mode: "per_student", why: `${i.fileCount} files: one paper per student.` };
  if (!i.isPdf || i.pageCount === null) return { mode: "per_student", why: "One file: one student's paper." };
  if (i.keyPageCount === null || i.keyPageCount < 1) {
    return { mode: "per_student", why: `One PDF of ${pages(i.pageCount)}: one student's paper.` };
  }
  if (i.pageCount > PACKET_FACTOR * i.keyPageCount) {
    return {
      mode: "packet",
      why: `One PDF of ${pages(i.pageCount)}, and the answer key has ${pages(i.keyPageCount)}: the whole class scanned together.`,
    };
  }
  return { mode: "per_student", why: `One PDF of ${pages(i.pageCount)}, about as long as the answer key: one student's paper.` };
}
