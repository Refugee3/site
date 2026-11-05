"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isAbortError, readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { prepareUploadFile, UNSUPPORTED_IMAGE } from "@/lib/client/upload-files";
import { createTaskQueue } from "./task-queue";
import { plural } from "./text";
import { parseTeacherUploadResult } from "./upload-result";
import { isRetryable, uploadErrorCode } from "./upload-retry";
import { useLeaveGuard } from "./use-leave-guard";

export type PaperUploadState = "waiting" | "uploading" | "done" | "failed";

export interface PaperUpload {
  id: number;
  file: File;
  state: PaperUploadState;
  progress: number;
  /** The paper the upload created, once done. */
  submissionId: string | null;
  error: string | null;
  /** The server's error code for a failed upload; null when no usable answer came back. */
  code: string | null;
}

/** Two uploads at a time: quick for a stack of scans without flooding the server or a classroom connection. */
const PARALLEL_UPLOADS = 2;

export interface PaperUploads {
  entries: PaperUpload[];
  /** Waiting or uploading. */
  remaining: number;
  busy: boolean;
  done: PaperUpload[];
  failed: PaperUpload[];
  /** Failed for a reason another try may fix (not a duplicate, the answer key or a broken file). */
  retryable: PaperUpload[];
  addFiles: (files: File[]) => void;
  retryFailed: () => void;
  clearFinished: () => void;
}

/**
 * The students' papers, one file per student and one request per file (images converted to JPEG first), PARALLEL_UPLOADS at
 * a time. Leaving the page cancels what is in flight (after a warning); once the queue drains, the server-rendered parts of the
 * page are refreshed.
 */
export function usePaperUploads(assignmentId: string): PaperUploads {
  const uploadUrl = `/api/teacher/assignments/${assignmentId}/submissions`;
  const router = useRouter();
  const [entries, setEntries] = useState<PaperUpload[]>([]);
  const nextId = useRef(0);
  const queue = useRef<ReturnType<typeof createTaskQueue<PaperUpload>> | null>(null);
  const controllers = useRef(new Map<number, AbortController>());
  const unmounted = useRef(false);
  const wasBusy = useRef(false);

  const remaining = entries.filter((entry) => entry.state === "waiting" || entry.state === "uploading").length;
  const busy = remaining > 0;
  const done = entries.filter((entry) => entry.state === "done");
  const failed = entries.filter((entry) => entry.state === "failed");
  const retryable = failed.filter((entry) => isRetryable(entry.code));

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

  useEffect(() => {
    if (wasBusy.current && !busy && done.length > 0) router.refresh();
    wasBusy.current = busy;
  }, [busy, done.length, router]);

  function patch(id: number, change: Partial<PaperUpload>) {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));
  }

  async function uploadOne(entry: PaperUpload): Promise<void> {
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
        patch(entry.id, { state: "done", submissionId: uploaded.submissionId });
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

  function enqueue(items: PaperUpload[]) {
    queue.current ??= createTaskQueue(PARALLEL_UPLOADS, uploadOne);
    queue.current.push(...items);
  }

  function addFiles(files: File[]) {
    const added = files.map((file): PaperUpload => ({
      id: nextId.current++, file, state: "waiting", progress: 0, submissionId: null, error: null, code: null,
    }));
    setEntries((current) => [...current, ...added]);
    enqueue(added);
  }

  function retryFailed() {
    retryable.forEach((entry) => patch(entry.id, { state: "waiting", error: null, code: null, progress: 0 }));
    enqueue(retryable);
  }

  function clearFinished() {
    setEntries((current) => current.filter((entry) => entry.state === "waiting" || entry.state === "uploading"));
  }

  return { entries, remaining, busy, done, failed, retryable, addFiles, retryFailed, clearFinished };
}
