"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { DropZone } from "@/components/ui/drop-zone";
import { formatBytes, UPLOAD_FORMATS } from "@/lib/client/upload-files";
import { usePaperUploads, type PaperUpload, type PaperUploads } from "./use-paper-uploads";

export interface BulkUploadProps {
  assignmentId: string;
  disabled: boolean;
}

/**
 * Uploads the students' papers, one file per student (any accepted format; images are converted to JPEG
 * first) and one request per file. Files start uploading as soon as they are dropped or picked; each finished one links to its
 * paper, which is then graded.
 */
export function BulkUpload({ assignmentId, disabled }: BulkUploadProps) {
  const uploads = usePaperUploads(assignmentId);
  return (
    <div className="flex flex-col gap-4">
      <DropZone
        onFiles={uploads.addFiles}
        disabled={disabled}
        title="Drop the students' papers here"
        hint={`One file per student (${UPLOAD_FORMATS}); uploads start right away and each paper is graded as soon as it arrives.`}
        inputId="bulk-upload-files"
      />
      <UploadList assignmentId={assignmentId} uploads={uploads} />
    </div>
  );
}

/** The uploads in progress and done: a count, retry and clear buttons, and one row per file. */
export function UploadList(props: {
  assignmentId: string;
  uploads: PaperUploads;
  resultsLink?: boolean;
  /** Once nothing is left to upload, list only the failed files (the workspace's feed shows each paper). */
  compactWhenDone?: boolean;
}) {
  const { assignmentId, uploads, resultsLink = true, compactWhenDone = false } = props;
  const { entries, done, failed, retryable, busy } = uploads;
  if (entries.length === 0) return null;
  const shown = compactWhenDone && !busy ? entries.filter((entry) => entry.state === "failed") : entries;
  return (
    <section aria-labelledby={`uploads-heading-${assignmentId}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`uploads-heading-${assignmentId}`} className="text-base font-semibold">
          Uploads
        </h3>
        <p aria-live="polite" className="text-sm text-muted">
          {done.length} of {entries.length} uploaded
          {failed.length > 0 && ` · ${failed.length} failed`}
          {resultsLink && !busy && done.length > 0 && (
            <>
              {" · "}
              <Link href={`/teacher/assignments/${assignmentId}`}>See the results</Link>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {retryable.length > 0 && (
          <Button variant="secondary" size="sm" onClick={uploads.retryFailed}>
            Retry failed ({retryable.length})
          </Button>
        )}
        {!busy && (
          <Button variant="ghost" size="sm" onClick={uploads.clearFinished}>
            Clear list
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-2 empty:hidden">
        {shown.map((entry) => (
          <UploadRow key={entry.id} entry={entry} assignmentId={assignmentId} />
        ))}
      </ul>
    </section>
  );
}

function UploadRow({ entry, assignmentId }: { entry: PaperUpload; assignmentId: string }) {
  const percent = Math.round(entry.progress * 100);
  return (
    <li
      className={cx(
        "flex flex-col gap-2 rounded-lg border p-3",
        entry.state === "failed" ? "border-danger-200 bg-danger-50" : "border-line bg-surface",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-medium">{entry.file.name}</span>
        <span className="text-sm text-muted">{formatBytes(entry.file.size)}</span>
      </div>
      {entry.state === "waiting" && <p className="text-sm text-muted">Waiting…</p>}
      {entry.state === "uploading" && (
        <div
          role="progressbar"
          aria-label={`Uploading ${entry.file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 w-full overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
      {entry.state === "done" && entry.submissionId && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium text-success-800">Uploaded — grading now</span>
          <Link href={`/teacher/assignments/${assignmentId}/submissions/${entry.submissionId}`}>
            Open this paper<span className="sr-only">: {entry.file.name}</span>
          </Link>
        </div>
      )}
      {entry.state === "failed" && <p className="text-sm font-medium text-danger-700">{entry.error}</p>}
    </li>
  );
}
