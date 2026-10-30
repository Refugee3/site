"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { DropZone } from "@/components/ui/drop-zone";
import { isAbortError, readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { prepareUploadFile, UNSUPPORTED_IMAGE, UPLOAD_FORMATS } from "@/lib/client/upload-files";
import type { AssignmentKind, ProjectMode } from "@/lib/types";
import { KeyInstructionsField } from "./key-instructions-field";
import { useLeaveGuard } from "./use-leave-guard";

function kindName(kind: AssignmentKind): string {
  return kind === "quiz" ? "quiz" : kind === "project" ? "project" : "homework";
}

/** The created assignment, as POST /api/teacher/assignments answers 201. */
function parseCreated(json: unknown): { workspaceUrl: string } | null {
  const url = (json as { workspaceUrl?: unknown } | null)?.workspaceUrl;
  return typeof url === "string" && url.startsWith("/teacher/assignments/") ? { workspaceUrl: url } : null;
}

const KINDS: Array<{ value: AssignmentKind; label: string }> = [
  { value: "homework", label: "Homework" },
  { value: "quiz", label: "Quiz" },
  { value: "project", label: "Project" },
];

const PROJECT_MODES: Array<{ value: ProjectMode; label: string }> = [
  { value: "points", label: "Score with points" },
  { value: "feedback", label: "Feedback only (no points)" },
];

/**
 * The dashboard's way in: drop (or pick) an answer key and a new homework or quiz is created with it, named by the AI once it
 * has read the key, and its workspace opens while the key is being read.
 */
export function NewFromKey({ defaultKind = "homework" }: { defaultKind?: AssignmentKind }) {
  const router = useRouter();
  const [kind, setKind] = useState<AssignmentKind>(defaultKind);
  const [instructions, setInstructions] = useState("");
  const [projectMode, setProjectMode] = useState<ProjectMode>("points");
  const project = kind === "project";
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
    body.append("instructions", instructions);
    if (project) body.append("projectMode", projectMode);
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
        <h2 id="new-from-key-heading" className="text-lg font-semibold">{project ? "Start a project" : "Start from an answer key"}</h2>
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
      {project && (
        <fieldset disabled={busy} className="flex flex-wrap gap-2">
          <legend className="sr-only">How projects are graded</legend>
          {PROJECT_MODES.map((option) => (
            <label
              key={option.value}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium has-checked:border-brand-600 has-checked:bg-brand-50 sm:min-h-9"
            >
              <input
                type="radio"
                name="new-project-mode"
                value={option.value}
                checked={projectMode === option.value}
                onChange={() => setProjectMode(option.value)}
                className="size-4 accent-brand-600"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      )}
      <KeyInstructionsField
        id="new-from-key-instructions"
        value={instructions}
        onChange={setInstructions}
        disabled={busy}
        project={project ? projectMode : undefined}
      />
      <DropZone
        onFiles={(files) => void start(files)}
        busy={busy}
        busyLabel={opening ? `Opening your new ${kindName(kind)}…` : `Uploading… ${Math.round((progress ?? 0) * 100)}%`}
        title={project ? "Drop a rubric (optional)" : `Drop an answer key to start a new ${kindName(kind)}`}
        hint={project
          ? `${UPLOAD_FORMATS}. A project needs no answer key: your instructions above are enough.`
          : `${UPLOAD_FORMATS}. The AI reads it, asks you anything it needs, and names the ${kindName(kind)} for you.`}
        buttonLabel={project ? "Choose a rubric" : "Choose the answer key"}
        inputId="dashboard-key-drop"
      />
      {project && (
        <Button
          className="self-start"
          disabled={busy || instructions.trim() === ""}
          onClick={() => void start([])}
          title={instructions.trim() === "" ? "Write the instructions first" : undefined}
        >
          Create project without a rubric
        </Button>
      )}
      <div aria-live="polite" className="empty:hidden">
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </section>
  );
}
