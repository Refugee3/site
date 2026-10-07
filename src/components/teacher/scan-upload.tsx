"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button-styles";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useHydrated } from "@/components/ui/use-hydrated";
import { isAbortError, readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { isPdfFile } from "@/lib/client/upload-files";
import type { ScanSplitMode } from "@/lib/types";
import { parseScanUploadResult } from "./scan-upload-result";
import { useLeaveGuard } from "./use-leave-guard";

export interface ScanUploadProps {
  /** `/api/teacher/assignments/<id>/scans` */
  uploadUrl: string;
  disabled: boolean;
  /** The worksheet's length, the likeliest number of pages per student. */
  keyPageCount: number | null;
}

const PAGES_ERROR = "Enter the pages per student as a whole number from 1 to 100.";

/** `?mode=…` for the upload, or null when "every N pages" has no valid N. */
function splitQuery(mode: ScanSplitMode, pagesText: string): string | null {
  if (mode === "auto") return "mode=auto";
  const pages = Number(pagesText.trim());
  if (!Number.isInteger(pages) || pages < 1 || pages > 100) return null;
  return `mode=every&pagesPerPaper=${pages}`;
}

/**
 * Uploads one scan of the whole class's papers as soon as it is chosen, then opens its split check. A clean AI
 * split is graded automatically; one with anything flagged (and every "every N pages" split) waits for the teacher there.
 */
export function ScanUpload({ uploadUrl, disabled, keyPageCount }: ScanUploadProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [mode, setMode] = useState<ScanSplitMode>("auto");
  const [pagesText, setPagesText] = useState(String(keyPageCount ?? 1));
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, startOpening] = useTransition();
  const controller = useRef<AbortController | null>(null);
  const busy = progress !== null || opening;
  const uploading = progress !== null;

  // Leaving the page cancels an upload in flight.
  useEffect(() => () => controller.current?.abort(), []);

  useLeaveGuard(uploading, "1 upload hasn't finished. Leaving this page cancels it. Leave anyway?");

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!isPdfFile(file)) {
      setError("Choose a PDF file. Scan the papers into one PDF first.");
      return;
    }
    const query = splitQuery(mode, pagesText);
    if (query === null) {
      setError(PAGES_ERROR);
      return;
    }

    const body = new FormData();
    body.append("file", file, file.name);
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setProgress(0);
    try {
      const result = await uploadWithProgress(`${uploadUrl}?${query}`, body, setProgress, abort.signal);
      const uploaded = result.status === 201 ? parseScanUploadResult(result.json) : null;
      if (uploaded) startOpening(() => router.push(uploaded.reviewUrl));
      else if (result.status === 201) setError("The server sent an unexpected answer.");
      else setError(readUploadError(result).message);
    } catch (e) {
      if (!isAbortError(e)) setError("The upload didn't go through. Check your connection and try again.");
    } finally {
      controller.current = null;
      setProgress(null);
    }
  }

  const locked = disabled || busy;
  return (
    <div className="flex flex-col gap-4">
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">How should the scan be split?</legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <Input type="radio" name="scan-split" checked={mode === "auto"} onChange={() => setMode("auto")} />
          <span>Automatic (AI finds where each student&apos;s paper starts)</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <Input type="radio" name="scan-split" checked={mode === "every"} onChange={() => setMode("every")} />
          <span>Every N pages</span>
        </label>
        {mode === "every" && (
          <div className="flex flex-col gap-1.5 pl-8">
            <label htmlFor="scan-pages-per-paper" className="text-sm font-medium">
              Pages per student
            </label>
            <div className="w-24">
              <Input
                id="scan-pages-per-paper"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                aria-describedby="scan-pages-per-paper-hint"
                value={pagesText}
                onChange={(e) => setPagesText(e.target.value)}
              />
            </div>
            <p id="scan-pages-per-paper-hint" className="text-sm text-muted">
              Use this when every paper has the same number of pages and there are no blank pages in between.
            </p>
          </div>
        )}
      </fieldset>

      <label
        aria-disabled={locked || !hydrated || undefined}
        className={buttonClasses({
          className: "cursor-pointer self-start focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600",
        })}
      >
        <input type="file" accept="application/pdf" disabled={locked || !hydrated} onChange={upload} className="sr-only" />
        {busy && <Spinner className="size-4" />}
        Choose the scan (PDF)
      </label>

      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {progress !== null && (
          <p className="text-sm text-muted">
            {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Uploaded. Checking the PDF…"}
          </p>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </div>
  );
}
