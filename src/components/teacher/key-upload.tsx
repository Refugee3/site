"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ChangeEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses, type ButtonVariant } from "@/components/ui/button-styles";
import { cx } from "@/components/ui/cx";
import { DropZone } from "@/components/ui/drop-zone";
import { Spinner } from "@/components/ui/spinner";
import { useFileDrop } from "@/components/ui/use-file-drop";
import { useHydrated } from "@/components/ui/use-hydrated";
import { readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { prepareUploadFile, UNSUPPORTED_IMAGE, UPLOAD_ACCEPT, UPLOAD_FORMATS } from "@/lib/client/upload-files";

export interface KeyUploadProps {
  /** `/api/teacher/assignments/<id>/key` */
  uploadUrl: string;
  disabled: boolean;
  label?: string;
  variant?: ButtonVariant;
  /** Asked after a file is chosen, when uploading would replace an existing key. */
  confirmText?: string;
  /** Shows a large drop zone with this main line instead of a button. */
  zoneTitle?: ReactNode;
  /** After a 202, besides refreshing the page (e.g. the workspace, which also follows the key live). */
  onUploaded?: () => void;
}

/**
 * Uploads the answer key as soon as it is chosen (several files are merged in order; images are converted to
 * JPEG first); on 202 the page refreshes into its "processing" state.
 */
export function KeyUpload(props: KeyUploadProps) {
  const { uploadUrl, disabled, label = "Upload answer key", variant = "primary", confirmText, zoneTitle, onUploaded } = props;
  const router = useRouter();
  const hydrated = useHydrated();
  const formatsId = useId();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const busy = progress !== null || refreshing;
  const pickerDisabled = !hydrated || disabled || busy;

  const drop = useFileDrop((files) => void upload(files), pickerDisabled);

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    void upload(picked);
  }

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
      if (result.status === 202) {
        onUploaded?.();
        startRefresh(() => router.refresh());
      }
      else setError(readUploadError(result).message);
    } catch {
      setError("The upload didn't go through. Check your connection and try again.");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {zoneTitle ? (
        <DropZone
          onFiles={(files) => void upload(files)}
          disabled={disabled}
          busy={busy}
          busyLabel={progress !== null && progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Starting to read the key…"}
          title={zoneTitle}
          hint={`${UPLOAD_FORMATS}; several files are joined in the order you pick them.`}
          inputId="key-upload-files"
          size="lg"
        />
      ) : (
        <>
          <label
            {...drop.handlers}
            aria-disabled={pickerDisabled || undefined}
            className={buttonClasses({
              variant,
              className: cx(
                "cursor-pointer self-start focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600",
                drop.dragging && "ring-4 ring-brand-100 outline-2 outline-brand-600",
              ),
            })}
          >
            <input
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              aria-describedby={formatsId}
              disabled={pickerDisabled}
              onChange={onPick}
              className="sr-only"
            />
            {busy && <Spinner className="size-4" />}
            {drop.dragging ? "Drop to upload" : label}
          </label>
          <p id={formatsId} className="text-sm text-muted">
            {UPLOAD_FORMATS}; several files are joined in the order you pick them (or drop them on the button).
          </p>
        </>
      )}
      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {progress !== null && (
          <p className="text-sm text-muted">
            {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Uploaded. Checking the file…"}
          </p>
        )}
        {refreshing && <p className="text-sm text-muted">Starting to read the key…</p>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </div>
  );
}
