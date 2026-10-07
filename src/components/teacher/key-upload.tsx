"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ChangeEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses, type ButtonVariant } from "@/components/ui/button-styles";
import { Spinner } from "@/components/ui/spinner";
import { useHydrated } from "@/components/ui/use-hydrated";
import { readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { isPdfFile } from "@/lib/client/upload-files";

export interface KeyUploadProps {
  /** `/api/teacher/assignments/<id>/key` */
  uploadUrl: string;
  disabled: boolean;
  label?: string;
  variant?: ButtonVariant;
  /** Asked after a file is chosen, when uploading would replace an existing key. */
  confirmText?: string;
}

/** Uploads the answer-key PDF as soon as it is chosen; on 202 the page refreshes into its "processing" state. */
export function KeyUpload(props: KeyUploadProps) {
  const { uploadUrl, disabled, label = "Upload answer key (PDF)", variant = "primary", confirmText } = props;
  const router = useRouter();
  const hydrated = useHydrated();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const busy = progress !== null || refreshing;
  const pickerDisabled = !hydrated || disabled || busy;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!isPdfFile(file)) {
      setError("Choose a PDF file. Scan or export the key as a PDF first.");
      return;
    }
    if (confirmText && !window.confirm(confirmText)) return;

    const body = new FormData();
    body.append("file", file, file.name);
    setError(null);
    setProgress(0);
    try {
      const result = await uploadWithProgress(uploadUrl, body, setProgress);
      if (result.status === 202) startRefresh(() => router.refresh());
      else setError(readUploadError(result).message);
    } catch {
      setError("The upload didn't go through. Check your connection and try again.");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        aria-disabled={pickerDisabled || undefined}
        className={buttonClasses({
          variant,
          className: "cursor-pointer self-start focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600",
        })}
      >
        <input
          type="file"
          accept="application/pdf"
          disabled={pickerDisabled}
          onChange={upload}
          className="sr-only"
        />
        {busy && <Spinner className="size-4" />}
        {label}
      </label>
      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {progress !== null && (
          <p className="text-sm text-muted">
            {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Uploaded. Checking the PDF…"}
          </p>
        )}
        {refreshing && <p className="text-sm text-muted">Starting to read the key…</p>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </div>
  );
}
