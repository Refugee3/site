"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { UPLOAD_ACCEPT } from "@/lib/client/upload-files";
import { cx } from "./cx";
import { Spinner } from "./spinner";
import { useHydrated } from "./use-hydrated";

export interface DropZoneProps {
  /** Called with the files dropped or picked, in order (never empty). */
  onFiles: (files: File[]) => void;
  /** The zone's main line ("Drop an answer key to start…"). */
  title: ReactNode;
  /** A second line: what can be dropped. */
  hint?: ReactNode;
  /** The button-like part of the zone (the whole zone opens the file picker). */
  buttonLabel?: string;
  disabled?: boolean;
  /** Shown while the files are being handled; the zone takes no more files meanwhile. */
  busy?: boolean;
  busyLabel?: ReactNode;
  multiple?: boolean;
  accept?: string;
  /** "lg" for the page's main call to action. */
  size?: "md" | "lg";
  /** Extra content under the hint, inside the zone (e.g. a toggle is better placed outside: it must not open the picker). */
  children?: ReactNode;
  className?: string;
  /** Names the file input for tests and labels ("dashboard-key-drop"). */
  inputId?: string;
}

/** True when a drag carries files (not text or a link dragged within the page). */
function hasFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * A drop area for files that is also a file picker: drag files anywhere onto it (the whole area lights up), or click or tap it,
 * or focus it with the keyboard and press Enter or Space. While files are dragged over the window, every zone on the page shows
 * it can take them, and files dropped beside a zone are ignored instead of opening in the tab.
 */
export function DropZone(props: DropZoneProps) {
  const {
    onFiles, title, hint, buttonLabel = "Choose files", disabled = false, busy = false, busyLabel, multiple = true,
    accept = UPLOAD_ACCEPT, size = "md", children, className, inputId,
  } = props;
  const hydrated = useHydrated();
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const hintId = `${id}-hint`;
  const [over, setOver] = useState(false);
  const [armed, setArmed] = useState(false);
  const depth = useRef(0);
  const off = disabled || busy || !hydrated;

  // Files dragged over the window: show every zone as a target, and keep a near miss from opening the file in the tab.
  useEffect(() => {
    let windowDepth = 0;
    const enter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      windowDepth++;
      setArmed(true);
    };
    const leave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      windowDepth = Math.max(0, windowDepth - 1);
      if (windowDepth === 0) setArmed(false);
    };
    const overWindow = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const end = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      windowDepth = 0;
      setArmed(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overWindow);
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overWindow);
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
    };
  }, []);

  function take(files: File[]) {
    const picked = multiple ? files : files.slice(0, 1);
    if (picked.length > 0 && !off) onFiles(picked);
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    take(files);
  }

  function onDragEnter(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current++;
    setOver(true);
  }

  function onDragOver(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = off ? "none" : "copy";
  }

  function onDragLeave(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    setArmed(false);
    take(Array.from(event.dataTransfer.files));
  }

  const active = over && !off;
  return (
    <div className={cx("flex min-w-0 flex-col gap-2", className)}>
      <label
        htmlFor={id}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-dragging={active || undefined}
        aria-disabled={off || undefined}
        className={cx(
          "group relative flex w-full min-w-0 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 text-center transition-colors",
          "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600",
          size === "lg" ? "min-h-48 py-8 sm:min-h-56" : "min-h-36 py-6",
          off ? "cursor-not-allowed border-line-strong bg-subtle opacity-70" : "cursor-pointer",
          !off && (active
            ? "border-brand-600 bg-brand-100 ring-4 ring-brand-100"
            : armed
              ? "border-brand-600 bg-brand-50"
              : "border-line-strong bg-surface hover:border-brand-600 hover:bg-brand-50"),
        )}
      >
        <input
          id={id}
          type="file"
          multiple={multiple}
          accept={accept}
          disabled={off}
          aria-describedby={hint ? hintId : undefined}
          onChange={onPick}
          className="sr-only"
        />
        {busy ? (
          <Spinner className="size-8 text-brand-600" />
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            className={cx("size-9 transition-transform", active ? "-translate-y-0.5 text-brand-700" : "text-brand-600")}>
            <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" />
            <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
          </svg>
        )}
        <span className={cx("max-w-prose font-semibold text-ink", size === "lg" ? "text-lg sm:text-xl" : "text-base")}>
          {busy && busyLabel ? busyLabel : active ? "Drop to upload" : title}
        </span>
        {hint && (
          <span id={hintId} className="max-w-prose text-sm text-muted">
            {hint}
          </span>
        )}
        {!busy && (
          <span className={cx(
            "mt-1 inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium sm:min-h-9",
            off ? "border border-line-strong bg-surface text-muted" : "bg-brand-600 text-white shadow-sm group-hover:bg-brand-700",
          )}>
            <span className="pointer-coarse:hidden">{buttonLabel}</span>
            <span className="hidden pointer-coarse:inline">Tap to {buttonLabel.charAt(0).toLowerCase()}{buttonLabel.slice(1)}</span>
          </span>
        )}
        {children}
      </label>
    </div>
  );
}
