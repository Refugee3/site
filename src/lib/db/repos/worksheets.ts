import { now } from "@/lib/clock";
import { encodePatch, one, run, toBit, updateRow, type ColumnMap } from "@/lib/db/sql";
import type { QuestionSpots, SpotSource } from "@/lib/omr/types";

// The blank worksheet of an assignment (blank_worksheets) and its answer spots, for mark detection.

export interface BlankWorksheet {
  assignmentId: string;
  pdfPath: string;
  originalFilename: string;
  contentSha256: string;
  byteSize: number;
  pageCount: number;
  /** Each page's size in points. */
  pageSizes: Array<{ width: number; height: number }>;
  /** The PDF has a text layer (a digital export); a scan has none. */
  hasText: boolean;
  /** "detecting": the AI is looking for the spots of a scanned blank. */
  status: "detecting" | "ready";
  spotsSource: SpotSource | null;
  spots: QuestionSpots[];
  /** Why the spots are as they are ("No AI is set up: draw the answer spots yourself."). */
  note: string | null;
  /** When the teacher last saved the spots; papers are only read from confirmed spots. */
  confirmedAt: number | null;
  /**
   * How many times the teacher saved the spots (0: never). Kept when the blank is replaced, so a paper graded with an earlier
   * map (submissions.graded_spot_revision) never matches a later one.
   */
  spotsRevision: number;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  assignment_id: string;
  pdf_path: string;
  original_filename: string;
  content_sha256: string;
  byte_size: number;
  page_count: number;
  page_sizes_json: string;
  has_text: 0 | 1;
  status: "detecting" | "ready";
  spots_source: SpotSource | null;
  spots_json: string;
  note: string | null;
  confirmed_at: number | null;
  spots_revision: number;
  created_at: number;
  updated_at: number;
}

function fromRow(row: Row): BlankWorksheet {
  return {
    assignmentId: row.assignment_id,
    pdfPath: row.pdf_path,
    originalFilename: row.original_filename,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    pageSizes: JSON.parse(row.page_sizes_json) as BlankWorksheet["pageSizes"],
    hasText: row.has_text === 1,
    status: row.status,
    spotsSource: row.spots_source,
    spots: JSON.parse(row.spots_json) as QuestionSpots[],
    note: row.note,
    confirmedAt: row.confirmed_at,
    spotsRevision: row.spots_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getWorksheet(assignmentId: string): BlankWorksheet | null {
  const row = one<Row>("SELECT * FROM blank_worksheets WHERE assignment_id = ?", assignmentId);
  return row ? fromRow(row) : null;
}

export type NewWorksheet = Omit<BlankWorksheet, "spotsRevision" | "createdAt" | "updatedAt">;

/**
 * Stores the assignment's blank worksheet, replacing any earlier one (whose spots revision carries over); returns the replaced
 * one's PDF path (to remove).
 */
export function putWorksheet(w: NewWorksheet): { worksheet: BlankWorksheet; replacedPdfPath: string | null } {
  const previous = getWorksheet(w.assignmentId);
  const at = now();
  run("DELETE FROM blank_worksheets WHERE assignment_id = ?", w.assignmentId);
  run(
    `INSERT INTO blank_worksheets (assignment_id, pdf_path, original_filename, content_sha256, byte_size, page_count, page_sizes_json,
       has_text, status, spots_source, spots_json, note, confirmed_at, spots_revision, created_at, updated_at)
     VALUES (@assignment_id, @pdf_path, @original_filename, @content_sha256, @byte_size, @page_count, @page_sizes_json,
       @has_text, @status, @spots_source, @spots_json, @note, @confirmed_at, @spots_revision, @created_at, @updated_at)`,
    {
      assignment_id: w.assignmentId, pdf_path: w.pdfPath, original_filename: w.originalFilename.slice(0, 300),
      content_sha256: w.contentSha256, byte_size: w.byteSize, page_count: w.pageCount, page_sizes_json: JSON.stringify(w.pageSizes),
      has_text: toBit(w.hasText), status: w.status, spots_source: w.spotsSource, spots_json: JSON.stringify(w.spots),
      note: w.note === null ? null : w.note.slice(0, 500), confirmed_at: w.confirmedAt, spots_revision: previous?.spotsRevision ?? 0,
      created_at: at, updated_at: at,
    },
  );
  return { worksheet: getWorksheet(w.assignmentId)!, replacedPdfPath: previous && previous.pdfPath !== w.pdfPath ? previous.pdfPath : null };
}

type Patch = Pick<BlankWorksheet, "status" | "spotsSource" | "spots" | "note" | "confirmedAt" | "spotsRevision">;

const COLUMNS: ColumnMap<Patch> = {
  status: "status",
  spotsSource: "spots_source",
  spots: ["spots_json", (spots) => JSON.stringify(spots)],
  note: ["note", (note) => (note === null ? null : note.slice(0, 500))],
  confirmedAt: "confirmed_at",
  spotsRevision: "spots_revision",
};

/** Updates the worksheet if it is still the one with `sha` (a re-upload meanwhile wins); null when it is not. */
export function updateWorksheet(assignmentId: string, sha: string, patch: Partial<Patch>): BlankWorksheet | null {
  const row = updateRow<Row>("blank_worksheets", { assignment_id: assignmentId, content_sha256: sha }, encodePatch(patch, COLUMNS));
  return row ? fromRow(row) : null;
}

export function deleteWorksheet(assignmentId: string): BlankWorksheet | null {
  const existing = getWorksheet(assignmentId);
  if (existing) run("DELETE FROM blank_worksheets WHERE assignment_id = ?", assignmentId);
  return existing;
}

export const INTERRUPTED_PROPOSAL_NOTE = "Finding the answer spots was interrupted. Try again, or draw them yourself.";

/**
 * Boot recovery: a worksheet left "detecting" will never be finished (the AI call died with the previous process), so the
 * teacher is asked to try again. Returns how many there were.
 */
export function resetDetectingWorksheets(): number {
  return run(
    `UPDATE blank_worksheets SET status = 'ready', spots_source = COALESCE(spots_source, 'manual'), note = ?, updated_at = ?
     WHERE status = 'detecting'`,
    INTERRUPTED_PROPOSAL_NOTE, now(),
  );
}
