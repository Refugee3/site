"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { cx } from "@/components/ui/cx";
import { Spinner } from "@/components/ui/spinner";
import { useHydrated } from "@/components/ui/use-hydrated";
import { receiptPathFrom, rememberSubmission } from "@/lib/client/recent-submissions";
import { isAbortError, newUploadId, readUploadError, UPLOAD_ID_HEADER, uploadWithProgress } from "@/lib/client/upload";
import { fileTypeLabel, formatBytes, isImageFile, moveItem, prepareUploadFile, UPLOAD_ACCEPT } from "@/lib/client/upload-files";

export interface UploadFormProps {
  /** The canonical share code. */
  code: string;
  /** `/api/s/<code>/submissions` */
  uploadUrl: string;
  maxUploadMb: number;
  maxFiles: number;
  maxPages: number;
}

interface Part {
  id: number;
  file: File;
  /** Object URL of a photo's thumbnail; null for PDFs and documents. */
  previewUrl: string | null;
}

type UploadState = { phase: "idle" } | { phase: "uploading"; fraction: number } | { phase: "opening-receipt" };

const UNSUPPORTED_PHOTO = "This photo format isn't supported here — use Take photos or a JPEG/PDF";
const ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface text-lg " +
  "text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40";

function revokePreview(part: Part): void {
  if (part.previewUrl) URL.revokeObjectURL(part.previewUrl);
}

export function UploadForm({ code, uploadUrl, maxUploadMb, maxFiles, maxPages }: UploadFormProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [parts, setParts] = useState<Part[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [upload, setUpload] = useState<UploadState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // One id per selection of pages: resending the same selection after an error reuses it, so the server
  // can hand back that upload's receipt; any change to the pages starts a new upload.
  const uploadId = useRef<{ parts: Part[]; id: string } | null>(null);

  // Thumbnails are object URLs; release whatever is still listed when the form goes away.
  const partsRef = useRef(parts);
  useEffect(() => {
    partsRef.current = parts;
  }, [parts]);
  useEffect(() => () => partsRef.current.forEach(revokePreview), []);

  const busy = preparing > 0 || upload.phase !== "idle";
  const totalBytes = parts.reduce((sum, part) => sum + part.file.size, 0);
  const maxBytes = maxUploadMb * 1024 * 1024;
  const tooLarge = totalBytes > maxBytes;
  // The pickers are disabled in the server HTML: a photo taken before hydration would be lost.
  const pickersDisabled = !hydrated || busy || parts.length >= maxFiles;

  function appendPart(file: File, previewUrl: string | null) {
    const part: Part = { id: nextId.current++, file, previewUrl };
    setParts((prev) => [...prev, part]);
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Clear the input so choosing the same file again still fires a change.
    event.target.value = "";
    if (picked.length === 0) return;

    const room = Math.max(0, maxFiles - parts.length);
    const accepted = picked.slice(0, room);
    const problems: string[] = [];
    if (picked.length > room)
      problems.push(`You can add at most ${maxFiles} files, so ${picked.length - room} were left out.`);
    setError(null);
    setNotices(problems);

    // Files are prepared one at a time and appended in the order they were picked.
    for (const file of accepted) {
      if (!isImageFile(file)) {
        appendPart(file, null);
        continue;
      }
      setPreparing((n) => n + 1);
      try {
        const photo = await prepareUploadFile(file);
        appendPart(photo, URL.createObjectURL(photo));
      } catch {
        problems.push(`${file.name || "A photo"}: ${UNSUPPORTED_PHOTO}`);
        setNotices([...problems]);
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  }

  function move(index: number, offset: -1 | 1) {
    setParts((prev) => moveItem(prev, index, offset));
  }

  function remove(id: number) {
    const part = parts.find((p) => p.id === id);
    if (part) revokePreview(part);
    setParts((prev) => prev.filter((p) => p.id !== id));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parts.length === 0 || tooLarge || busy) return;

    const body = new FormData();
    for (const part of parts) body.append("files", part.file, part.file.name);
    if (uploadId.current?.parts !== parts) uploadId.current = { parts, id: newUploadId() };
    const headers = { [UPLOAD_ID_HEADER]: uploadId.current.id };
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setNotices([]);
    setUpload({ phase: "uploading", fraction: 0 });

    try {
      const result = await uploadWithProgress(
        uploadUrl,
        body,
        (fraction) => setUpload({ phase: "uploading", fraction }),
        controller.signal,
        headers,
      );
      const receiptUrl = result.status < 300 ? receiptPathFrom(result.json) : null;
      if (receiptUrl) {
        rememberSubmission({ code, receiptUrl, at: Date.now() });
        setUpload({ phase: "opening-receipt" });
        router.push(receiptUrl);
        return;
      }
      setError(
        result.status < 300 ? "The server sent an unexpected answer. Try again." : readUploadError(result).message,
      );
    } catch (e) {
      setError(
        isAbortError(e)
          ? "Upload cancelled. Your files are still here."
          : "The upload didn't go through. Check your internet connection and try again — your files are still here.",
      );
    } finally {
      abortRef.current = null;
    }
    setUpload({ phase: "idle" });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <FilePicker
          label="Take photos"
          accept="image/*"
          capture
          disabled={pickersDisabled}
          onChange={addFiles}
          variant="primary"
        />
        <FilePicker
          label="Choose files"
          accept={UPLOAD_ACCEPT}
          disabled={pickersDisabled}
          onChange={addFiles}
          variant="secondary"
        />
      </div>

      <div aria-live="polite" className="flex flex-col gap-2">
        {preparing > 0 && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4" />
            Preparing {preparing === 1 ? "photo" : `${preparing} photos`}…
          </p>
        )}
        {notices.map((notice, index) => (
          <Alert key={`${index}:${notice}`} tone="warning">
            {notice}
          </Alert>
        ))}
      </div>

      {parts.length > 0 && (
        <section aria-labelledby="upload-files-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="upload-files-heading" className="text-base font-semibold">
              Your pages, in order
            </h3>
            <p className={cx("text-sm", tooLarge ? "font-medium text-danger-700" : "text-muted")}>
              {parts.length} of {maxFiles} files · {formatBytes(totalBytes)} of {maxUploadMb} MB
            </p>
          </div>
          <ol className="flex flex-col gap-2">
            {parts.map((part, index) => (
              <PartRow
                key={part.id}
                part={part}
                position={index + 1}
                isFirst={index === 0}
                isLast={index === parts.length - 1}
                disabled={upload.phase !== "idle"}
                onMove={(offset) => move(index, offset)}
                onRemove={() => remove(part.id)}
              />
            ))}
          </ol>
          {tooLarge && (
            <Alert tone="danger">
              Your files add up to {formatBytes(totalBytes)}, over the {maxUploadMb} MB limit. Remove a file, or take
              photos instead of uploading a large PDF.
            </Alert>
          )}
        </section>
      )}

      {error && (
        <Alert tone="danger" title="Not submitted yet">
          {error}
        </Alert>
      )}

      {upload.phase === "idle" ? (
        <Button type="submit" size="lg" disabled={parts.length === 0 || tooLarge || preparing > 0} className="w-full">
          {parts.length === 0
            ? "Add your pages first"
            : `Submit ${parts.length} ${parts.length === 1 ? "file" : "files"}`}
        </Button>
      ) : (
        <UploadProgress upload={upload} onCancel={() => abortRef.current?.abort()} />
      )}

      <p className="text-sm text-muted">
        PDF, photos, Word or text files: up to {maxFiles} files, {maxUploadMb} MB in total, {maxPages} pages. Photos are
        shrunk before uploading.
      </p>
    </form>
  );
}

function FilePicker(props: {
  label: string;
  accept: string;
  capture?: boolean;
  disabled: boolean;
  variant: "primary" | "secondary";
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  // A label styled as a button opens the picker; the visually hidden input keeps keyboard and screen-reader access.
  return (
    <label
      aria-disabled={props.disabled || undefined}
      className={buttonClasses({
        variant: props.variant,
        size: "lg",
        className:
          "w-full cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600",
      })}
    >
      <input
        type="file"
        multiple
        accept={props.accept}
        capture={props.capture ? "environment" : undefined}
        disabled={props.disabled}
        onChange={props.onChange}
        className="sr-only"
      />
      {props.label}
    </label>
  );
}

function PartRow(props: {
  part: Part;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { part, position } = props;
  const name = part.file.name;
  return (
    // On narrow phones the buttons wrap under the file name instead of squeezing it.
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface p-2">
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <span className="w-6 shrink-0 text-center text-sm font-semibold text-muted">{position}</span>
        {part.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, not an optimizable asset
          <img src={part.previewUrl} alt="" className="size-12 shrink-0 rounded border border-line object-cover" />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded border border-line bg-subtle text-xs font-semibold text-muted">
            {fileTypeLabel(name)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block text-xs text-muted">{formatBytes(part.file.size)}</span>
        </span>
      </span>
      <span className="ml-auto flex shrink-0 gap-1">
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={props.disabled || props.isFirst}
          onClick={() => props.onMove(-1)}
          aria-label={`Move file ${position} (${name}) up`}
        >
          ↑
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={props.disabled || props.isLast}
          onClick={() => props.onMove(1)}
          aria-label={`Move file ${position} (${name}) down`}
        >
          ↓
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={props.disabled}
          onClick={props.onRemove}
          aria-label={`Remove file ${position} (${name})`}
        >
          <svg
            viewBox="0 0 20 20"
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    </li>
  );
}

function UploadProgress({
  upload,
  onCancel,
}: {
  upload: Exclude<UploadState, { phase: "idle" }>;
  onCancel: () => void;
}) {
  const percent = upload.phase === "uploading" ? Math.round(upload.fraction * 100) : 100;
  const message =
    upload.phase === "opening-receipt"
      ? "Submitted! Opening your receipt…"
      : percent < 100
        ? "Uploading your files…"
        : "Uploaded. Putting your pages together…";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="flex items-center gap-2 font-medium">
          <Spinner className="size-4" />
          {message}
        </p>
        <span aria-hidden="true" className="text-sm font-semibold tabular-nums">
          {percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-3 w-full overflow-hidden rounded-full bg-line"
      >
        <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      {upload.phase === "uploading" && (
        <Button variant="secondary" onClick={onCancel} className="self-start">
          Cancel upload
        </Button>
      )}
    </div>
  );
}
