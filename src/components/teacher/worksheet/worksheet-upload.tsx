"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { DropZone } from "@/components/ui/drop-zone";
import { readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { prepareUploadFile, UNSUPPORTED_IMAGE, UPLOAD_FORMATS } from "@/lib/client/upload-files";

/** Uploads the blank worksheet as soon as it is dropped or chosen; the page then shows its answer spots. */
export function WorksheetUpload({ uploadUrl, title, confirmText }: { uploadUrl: string; title: string; confirmText?: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const busy = progress !== null || refreshing;

  async function upload(picked: File[]) {
    if (picked.length === 0) return;
    if (confirmText && !window.confirm(confirmText)) return;
    const body = new FormData();
    setError(null);
    setProgress(0);
    try {
      for (const file of picked) {
        let prepared: File;
        try {
          prepared = await prepareUploadFile(file);
        } catch {
          setError(`${file.name || "A photo"}: ${UNSUPPORTED_IMAGE}`);
          return;
        }
        body.append("file", prepared, prepared.name);
      }
      const result = await uploadWithProgress(uploadUrl, body, setProgress);
      if (result.status === 201) startRefresh(() => router.refresh());
      else setError(readUploadError(result).message);
    } catch {
      setError("The upload didn't go through. Check your connection and try again.");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <DropZone
        onFiles={(files) => void upload(files)}
        busy={busy}
        busyLabel={progress !== null && progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Finding the answer spots…"}
        title={title}
        hint={`${UPLOAD_FORMATS}. Best: the worksheet exported as PDF from Word or Google Docs, before anyone wrote on it.`}
        inputId="worksheet-upload-files"
      />
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
