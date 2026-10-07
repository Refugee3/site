import { now } from "@/lib/clock";
import { getAssignment } from "@/lib/db/repos/assignments";
import { all, encodePatch, one, run, updateRow, type ColumnMap } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import type { AiUsage, Assignment, PendingScans, Scan, ScanLayout, ScanPageReading, ScanSplitMode, ScanStatus } from "@/lib/types";

export type NewScan = Pick<Scan, "id" | "assignmentId" | "splitMode" | "pagesPerPaper" | "pdfPath" | "originalFilename" | "contentSha256"
  | "byteSize" | "pageCount"> & { status: "splitting" | "review"; layout: ScanLayout | null };

type ScanFields = Pick<Scan, "status" | "splitMode" | "pagesPerPaper" | "splitGeneration" | "readings" | "pagesRead" | "layout"
  | "proposedLayout" | "statusNote" | "errorMessage" | "aiModel" | "usage" | "createdCount" | "duplicateCount">;
export type ScanPatch = Partial<ScanFields>;

interface ScanRow {
  id: string;
  assignment_id: string;
  status: ScanStatus;
  split_mode: ScanSplitMode;
  pages_per_paper: number | null;
  split_generation: number;
  pdf_path: string;
  original_filename: string;
  content_sha256: string;
  byte_size: number;
  page_count: number;
  readings_json: string;
  pages_read: number;
  layout_json: string | null;
  proposed_layout_json: string | null;
  status_note: string | null;
  error_message: string | null;
  ai_model: string | null;
  usage_json: string | null;
  created_count: number | null;
  duplicate_count: number | null;
  created_at: number;
  updated_at: number;
}

function jsonOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function parseOrNull<T>(json: string | null): T | null {
  return json === null ? null : (JSON.parse(json) as T);
}

function scanFromRow(row: ScanRow): Scan {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    status: row.status,
    splitMode: row.split_mode,
    pagesPerPaper: row.pages_per_paper,
    splitGeneration: row.split_generation,
    pdfPath: row.pdf_path,
    originalFilename: row.original_filename,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    readings: JSON.parse(row.readings_json) as Array<ScanPageReading | null>,
    pagesRead: row.pages_read,
    layout: parseOrNull<ScanLayout>(row.layout_json),
    proposedLayout: parseOrNull<ScanLayout>(row.proposed_layout_json),
    statusNote: row.status_note,
    errorMessage: row.error_message,
    aiModel: row.ai_model,
    usage: parseOrNull<AiUsage>(row.usage_json),
    createdCount: row.created_count,
    duplicateCount: row.duplicate_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The proposed layout starts out as `layout`. */
export function insertScan(s: NewScan): Scan {
  const at = now();
  const layout = jsonOrNull(s.layout);
  const row = one<ScanRow>(
    `INSERT INTO scans (id, assignment_id, status, split_mode, pages_per_paper, pdf_path, original_filename, content_sha256,
       byte_size, page_count, layout_json, proposed_layout_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    s.id, s.assignmentId, s.status, s.splitMode, s.pagesPerPaper, s.pdfPath, s.originalFilename, s.contentSha256,
    s.byteSize, s.pageCount, layout, layout, at, at,
  );
  return scanFromRow(row!);
}

export function getScan(id: string): Scan | null {
  const row = one<ScanRow>("SELECT * FROM scans WHERE id = ?", id);
  return row ? scanFromRow(row) : null;
}

export function getScanForTeacher(id: string, teacherId: string): { scan: Scan; assignment: Assignment } | null {
  const row = one<ScanRow>(
    `SELECT s.* FROM scans s JOIN assignments a ON a.id = s.assignment_id
     WHERE s.id = ? AND a.teacher_id = ?`,
    id, teacherId,
  );
  if (!row) return null;
  const assignment = getAssignment(row.assignment_id);
  return assignment ? { scan: scanFromRow(row), assignment } : null;
}

/** Newest first. */
export function listScans(assignmentId: string): Scan[] {
  return all<ScanRow>("SELECT * FROM scans WHERE assignment_id = ? ORDER BY created_at DESC, rowid DESC", assignmentId)
    .map(scanFromRow);
}

/** The assignment's scans still waiting on the AI or the teacher; `firstReviewId` is the oldest one in review. */
export function countPendingScans(assignmentId: string): PendingScans {
  const counts = all<{ status: ScanStatus; n: number }>(
    `SELECT status, COUNT(*) AS n FROM scans WHERE assignment_id = ? AND status IN ('splitting', 'review', 'failed')
     GROUP BY status`,
    assignmentId,
  );
  const count = (status: ScanStatus) => counts.find((row) => row.status === status)?.n ?? 0;
  const first = one<{ id: string }>(
    "SELECT id FROM scans WHERE assignment_id = ? AND status = 'review' ORDER BY created_at, rowid LIMIT 1",
    assignmentId,
  );
  return { splitting: count("splitting"), review: count("review"), failed: count("failed"), firstReviewId: first?.id ?? null };
}

/** The newest scan of this assignment with this content, if any. */
export function findScanBySha(assignmentId: string, sha: string): Scan | null {
  const row = one<ScanRow>(
    "SELECT * FROM scans WHERE assignment_id = ? AND content_sha256 = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    assignmentId, sha,
  );
  return row ? scanFromRow(row) : null;
}

const SCAN_COLUMNS: ColumnMap<ScanFields> = {
  status: "status",
  splitMode: "split_mode",
  pagesPerPaper: "pages_per_paper",
  splitGeneration: "split_generation",
  readings: ["readings_json", (readings) => JSON.stringify(readings)],
  pagesRead: "pages_read",
  layout: ["layout_json", jsonOrNull],
  proposedLayout: ["proposed_layout_json", jsonOrNull],
  statusNote: "status_note",
  errorMessage: "error_message",
  aiModel: "ai_model",
  usage: ["usage_json", jsonOrNull],
  createdCount: "created_count",
  duplicateCount: "duplicate_count",
};

/** Throws AppError("not_found") when the scan does not exist. */
export function updateScan(id: string, patch: ScanPatch): Scan {
  const row = updateRow<ScanRow>("scans", { id }, encodePatch(patch, SCAN_COLUMNS));
  if (!row) throw new AppError("not_found", "Scan not found.");
  return scanFromRow(row);
}

/**
 * The write of an AI split run: applied only while the scan is still splitting on `generation`.
 * False means the run was superseded ("every N", "try again", deleted) and nothing was written.
 */
export function updateSplittingScan(id: string, generation: number, patch: ScanPatch): boolean {
  const where = { id, status: "splitting", split_generation: generation };
  return updateRow<ScanRow>("scans", where, encodePatch(patch, SCAN_COLUMNS)) !== undefined;
}

export function deleteScanRow(id: string): void {
  run("DELETE FROM scans WHERE id = ?", id);
}

/** Splitting scans with no queued or running split job (boot recovery), oldest first. */
export function listSplittingScansWithoutJob(): Array<{ id: string; assignmentId: string }> {
  return all<{ id: string; assignment_id: string }>(
    `SELECT s.id, s.assignment_id FROM scans s
     WHERE s.status = 'splitting'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'split_scan' AND j.target_id = s.id
                       AND j.status IN ('queued', 'running'))
     ORDER BY s.created_at, s.rowid`,
  ).map((row) => ({ id: row.id, assignmentId: row.assignment_id }));
}

/** Boot recovery: papers are created inside a request, so a scan left `creating` goes back to `review`. */
export function resetCreatingScans(): number {
  return run("UPDATE scans SET status = 'review', updated_at = ? WHERE status = 'creating'", now());
}
