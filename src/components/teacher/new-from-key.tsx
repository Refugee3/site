"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { cx } from "@/components/ui/cx";
import { DropZone } from "@/components/ui/drop-zone";
import { isAbortError, readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { prepareUploadFile, UNSUPPORTED_IMAGE, UPLOAD_FORMATS } from "@/lib/client/upload-files";
import type { AssignmentKind } from "@/lib/types";
import { useLeaveGuard } from "./use-leave-guard";

/** The created assignment, as POST /api/teacher/assignments answers 201. */
function parseCreated(json: unknown): { workspaceUrl: string } | null {
  const url = (json as { workspaceUrl?: unknown } | null)?.workspaceUrl;
  return typeof url === "string" && url.startsWith("/teacher/assignments/") ? { workspaceUrl: url } : null;
}

const KINDS: Array<{ value: AssignmentKind; label: string }> = [
  { value: "homework", label: "Homework" },
  { value: "quiz", label: "Quiz" },
];

/**
 * The dashboard's way in: drop (or pick) an answer key and a new homework or quiz is created with it, named by the AI once it
 * has read the key, and its workspace opens while the key is being read.
 */
export function NewFromKey({ defaultKind = "homework" }: { defaultKind?: AssignmentKind }) {
  const router = useRouter();
  const [kind, setKind] = useState<AssignmentKind>(defaultKind);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, startOpening] = useTransition();
  const controller = useRef<AbortController | null>(null);
  const uploading = progress !== null;

  useEffect(() => () => controller.current?.abort(), []);
  useLeaveGuard(uploading, "The answer key is still uploading. Leaving this page cancels it. Leave anyway?");

  async function start(files: File[]) {
    setError(null);
    const body = new FormData();
    for (const file of files) {
      try {
        const prepared = await prepareUploadFile(file);
        body.append("file", prepared, prepared.name);
      } catch {
        setError(`${file.name || "A photo"}: ${UNSUPPORTED_IMAGE}`);
        return;
      }
    }
    const abort = new AbortController();
    controller.current = abort;
    setProgress(0);
    try {
      const result = await uploadWithProgress(`/api/teacher/assignments?kind=${kind}`, body, setProgress, abort.signal);
      const created = result.status === 201 ? parseCreated(result.json) : null;
      if (created) startOpening(() => router.push(created.workspaceUrl));
      else if (result.status === 201) setError("The server sent an unexpected answer.");
      else setError(readUploadError(result).message);
    } catch (e) {
      if (!isAbortError(e)) setError("The upload didn't go through. Check your connection and try again.");
    } finally {
      controller.current = null;
      setProgress(null);
    }
  }

  const busy = uploading || opening;
  return (
    <section aria-labelledby="new-from-key-heading" className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="new-from-key-heading" className="text-lg font-semibold">Start from an answer key</h2>
        <fieldset disabled={busy} className="min-w-0">
          <legend className="sr-only">Type</legend>
          <div className="inline-flex rounded-lg border border-line-strong bg-subtle p-0.5">
            {KINDS.map((option) => (
              <label
                key={option.value}
                className={cx(
                  "flex min-h-11 cursor-pointer items-center rounded-md px-4 text-sm font-medium sm:min-h-9",
                  "has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-brand-600",
                  kind === option.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
                )}
              >
                <input
                  type="radio"
                  name="new-from-key-kind"
                  value={option.value}
                  checked={kind === option.value}
                  onChange={() => setKind(option.value)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <DropZone
        onFiles={(files) => void start(files)}
        busy={busy}
        busyLabel={opening ? "Opening your new " + (kind === "quiz" ? "quiz" : "homework") + "…" : `Uploading the key… ${Math.round((progress ?? 0) * 100)}%`}
        title={`Drop an answer key to start a new ${kind === "quiz" ? "quiz" : "homework"}`}
        hint={`${UPLOAD_FORMATS}. The AI reads it, asks you anything it needs, and names the ${kind === "quiz" ? "quiz" : "homework"} for you.`}
        buttonLabel="Choose the answer key"
        inputId="dashboard-key-drop"
      />
      <div aria-live="polite" className="empty:hidden">
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </section>
  );
}
