"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { cx } from "@/components/ui/cx";
import { useHydrated } from "@/components/ui/use-hydrated";
import { isAbortError, readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { formatBytes, prepareUploadFile, UNSUPPORTED_IMAGE, UPLOAD_ACCEPT, UPLOAD_FORMATS } from "@/lib/client/upload-files";
import { createTaskQueue } from "./task-queue";
import { plural } from "./text";
import { parseTeacherUploadResult } from "./upload-result";
import { isRetryable, uploadErrorCode } from "./upload-retry";
import { useLeaveGuard } from "./use-leave-guard";

export interface BulkUploadProps {
  /** `/api/teacher/assignments/<id>/submissions` */
  uploadUrl: string;
  disabled: boolean;
}

type EntryState = "waiting" | "uploading" | "done" | "failed";

interface Entry {
  id: number;
  file: File;
  state: EntryState;
  progress: number;
  receiptUrl: string | null;
  error: string | null;
  /** The server's error code for a failed upload; null when no usable answer came back. */
  code: string | null;
}

/** Two uploads at a time: quick for a stack of scans without flooding the server or a classroom connection. */
const PARALLEL_UPLOADS = 2;

/**
 * Uploads scanned paper copies, one file per student (any accepted format; images are converted to JPEG
 * first) and one request per file. Files start uploading as soon as
 * they are added; each finished one shows its receipt link for the teacher to hand to the student.
 */
export function BulkUpload({ uploadUrl, disabled }: BulkUploadProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(0);
  const queue = useRef<ReturnType<typeof createTaskQueue<Entry>> | null>(null);
  const controllers = useRef(new Map<number, AbortController>());
  const unmounted = useRef(false);

  const remaining = entries.filter((entry) => entry.state === "waiting" || entry.state === "uploading").length;
  const busy = remaining > 0;
  const done = entries.filter((entry) => entry.state === "done");
  const failed = entries.filter((entry) => entry.state === "failed");
  // Failures the same file would get again (a duplicate, the answer key, a broken PDF) are not offered a retry.
  const retryable = failed.filter((entry) => isRetryable(entry.code));
  const wasBusy = useRef(false);

  // Leaving the page stops what is in flight and what is still waiting.
  useEffect(() => {
    const inFlight = controllers.current;
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      inFlight.forEach((controller) => controller.abort());
    };
  }, []);

  useLeaveGuard(
    busy,
    `${plural(remaining, "upload")} ${remaining === 1 ? "hasn't" : "haven't"} finished. Leaving this page cancels ${remaining === 1 ? "it" : "them"}. Leave anyway?`,
  );

  // Once the queue drains, refresh the server-rendered counts (the header's paper count); this list stays as is.
  useEffect(() => {
    if (wasBusy.current && !busy && done.length > 0) router.refresh();
    wasBusy.current = busy;
  }, [busy, done.length, router]);

  function patch(id: number, change: Partial<Entry>) {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));
  }

  async function uploadOne(entry: Entry): Promise<void> {
    if (unmounted.current) return;
    const controller = new AbortController();
    controllers.current.set(entry.id, controller);
    patch(entry.id, { state: "uploading", progress: 0, error: null, code: null });

    const body = new FormData();
    try {
      let file: File;
      try {
        file = await prepareUploadFile(entry.file);
      } catch {
        patch(entry.id, { state: "failed", error: UNSUPPORTED_IMAGE, code: "unsupported_type" });
        return;
      }
      body.append("file", file, file.name);
      const result = await uploadWithProgress(uploadUrl, body, (progress) => patch(entry.id, { progress }), controller.signal);
      const uploaded = result.status === 201 ? parseTeacherUploadResult(result.json) : null;
      if (uploaded) {
        patch(entry.id, { state: "done", receiptUrl: uploaded.receiptUrl });
      } else if (result.status === 201) {
        patch(entry.id, { state: "failed", error: "The server sent an unexpected answer." });
      } else {
        const error = readUploadError(result);
        patch(entry.id, { state: "failed", error: error.message, code: uploadErrorCode(result.status, error.code) });
      }
    } catch (e) {
      const message = isAbortError(e) ? "Cancelled." : "The upload didn't go through. Check your connection and retry.";
      patch(entry.id, { state: "failed", error: message });
    } finally {
      controllers.current.delete(entry.id);
    }
  }

  function enqueue(items: Entry[]) {
    queue.current ??= createTaskQueue(PARALLEL_UPLOADS, uploadOne);
    queue.current.push(...items);
  }

  function addFiles(files: File[]) {
    const added = files.map((file): Entry => ({
      id: nextId.current++,
      file,
      state: "waiting",
      progress: 0,
      receiptUrl: null,
      error: null,
      code: null,
    }));
    setEntries((current) => [...current, ...added]);
    enqueue(added);
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!disabled) addFiles(Array.from(event.dataTransfer.files));
  }

  function retryFailed() {
    retryable.forEach((entry) => patch(entry.id, { state: "waiting", error: null, code: null, progress: 0 }));
    enqueue(retryable);
  }

  function clearFinished() {
    setEntries((current) => current.filter((entry) => entry.state === "waiting" || entry.state === "uploading"));
  }

  const allLinks = done.map((entry) => `${entry.file.name}\t${entry.receiptUrl}`).join("\n");

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cx(
          "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center",
          dragging ? "border-brand-600 bg-brand-50" : "border-line-strong bg-subtle",
        )}
      >
        <label
          aria-disabled={disabled || !hydrated || undefined}
          className={buttonClasses({
            className: "cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600",
          })}
        >
          <input
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            disabled={disabled || !hydrated}
            onChange={onPick}
            className="sr-only"
          />
          Choose files
        </label>
        <p className="text-sm text-muted">
          …or drop them here. One file per student ({UPLOAD_FORMATS}); uploads start right away.
        </p>
      </div>

      {entries.length > 0 && (
        <section aria-labelledby="bulk-upload-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="bulk-upload-heading" className="text-base font-semibold">
              Uploads
            </h3>
            <p aria-live="polite" className="text-sm text-muted">
              {done.length} of {entries.length} uploaded
              {failed.length > 0 && ` · ${failed.length} failed`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {retryable.length > 0 && (
              <Button variant="secondary" size="sm" onClick={retryFailed}>
                Retry failed ({retryable.length})
              </Button>
            )}
            {done.length > 0 && <CopyButton value={allLinks} label="Copy all receipt links" />}
            {!busy && (
              <Button variant="ghost" size="sm" onClick={clearFinished}>
                Clear list
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <UploadRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function UploadRow({ entry }: { entry: Entry }) {
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
      {entry.state === "done" && entry.receiptUrl && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="font-medium text-success-800">Uploaded</span>
          <a href={entry.receiptUrl} target="_blank" rel="noopener" className="min-w-0 break-all">
            {entry.receiptUrl}
          </a>
          <CopyButton value={entry.receiptUrl} label="Copy student link" />
        </div>
      )}
      {entry.state === "failed" && <p className="text-sm font-medium text-danger-700">{entry.error}</p>}
    </li>
  );
}
