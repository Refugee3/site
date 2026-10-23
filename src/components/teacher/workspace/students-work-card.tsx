"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/ui/drop-zone";
import { countPdfPages } from "@/lib/client/pdf-pages";
import { isAbortError, readUploadError, uploadWithProgress } from "@/lib/client/upload";
import { formatBytes, isPdfFile, prepareUploadFile, UNSUPPORTED_IMAGE, UPLOAD_FORMATS } from "@/lib/client/upload-files";
import { UploadList } from "../bulk-upload";
import { plural } from "../text";
import { detectUploadMode, type PaperUploadMode, type UploadModeGuess } from "../upload-mode";
import { useLeaveGuard } from "../use-leave-guard";
import { usePaperUploads } from "../use-paper-uploads";

export interface StudentsWorkCardProps {
  assignmentId: string;
  keyApproved: boolean;
  /** The answer key's pages: a single PDF much longer than this is the whole class. */
  keyPageCount: number | null;
  /** Grading a scan in one pass is available (not with the hosted agent, which splits it first). */
  onePassAvailable: boolean;
  /** "homework" / "quizzes": the drop zone's wording. */
  noun: string;
}

interface Pending {
  file: File;
  pageCount: number | null;
  guess: UploadModeGuess;
  mode: PaperUploadMode;
}

/**
 * Step 2 of the workspace: one drop zone for the students' work. Several files are one paper per student, uploaded at once. One
 * file is checked first: a PDF much longer than the key is taken for the whole class in one scan (graded in one pass), anything
 * else for one student's paper; the teacher sees which and can switch with one click before it uploads.
 */
export function StudentsWorkBody({ assignmentId, keyApproved, keyPageCount, onePassAvailable, noun }: StudentsWorkCardProps) {
  const router = useRouter();
  const uploads = usePaperUploads(assignmentId);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [packetProgress, setPacketProgress] = useState<number | null>(null);
  const [packetDone, setPacketDone] = useState<{ name: string; reviewUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useLeaveGuard(packetProgress !== null, "The class's scan is still uploading. Leaving this page cancels it. Leave anyway?");

  async function onFiles(files: File[]) {
    setError(null);
    setPacketDone(null);
    if (files.length > 1) {
      setPending(null);
      uploads.addFiles(files);
      return;
    }
    const [file] = files;
    setChecking(true);
    const pageCount = isPdfFile(file) ? await countPdfPages(file) : null;
    setChecking(false);
    const guess = detectUploadMode({ fileCount: 1, isPdf: isPdfFile(file), pageCount, keyPageCount });
    setPending({ file, pageCount, guess, mode: guess.mode });
  }

  function confirm() {
    if (!pending) return;
    setPending(null);
    if (pending.mode === "per_student") uploads.addFiles([pending.file]);
    else void uploadPacket(pending.file);
  }

  async function uploadPacket(file: File) {
    const body = new FormData();
    try {
      const prepared = await prepareUploadFile(file);
      body.append("file", prepared, prepared.name);
    } catch {
      setError(`${file.name || "A photo"}: ${UNSUPPORTED_IMAGE}`);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setPacketProgress(0);
    try {
      const mode = onePassAvailable ? "one_pass" : "auto";
      const result = await uploadWithProgress(`/api/teacher/assignments/${assignmentId}/scans?mode=${mode}`, body, setPacketProgress, abort.signal);
      const reviewUrl = (result.json as { reviewUrl?: unknown } | null)?.reviewUrl;
      if (result.status === 201 && typeof reviewUrl === "string") {
        setPacketDone({ name: file.name, reviewUrl });
        router.refresh();
      } else if (result.status === 201) {
        setError("The server sent an unexpected answer.");
      } else {
        setError(readUploadError(result).message);
      }
    } catch (e) {
      if (!isAbortError(e)) setError("The upload didn't go through. Check your connection and try again.");
    } finally {
      controller.current = null;
      setPacketProgress(null);
    }
  }

  const uploadingPacket = packetProgress !== null;
  return (
    <>
      <DropZone
        onFiles={(files) => void onFiles(files)}
        disabled={!keyApproved || pending !== null}
        busy={checking || uploadingPacket}
        busyLabel={uploadingPacket ? `Uploading the class's scan… ${Math.round((packetProgress ?? 0) * 100)}%` : "Checking the file…"}
        title={keyApproved ? `Drop your students' ${noun} here` : "Approve the answer key first"}
        hint={keyApproved
          ? `One file per student, or one scan of the whole class (${UPLOAD_FORMATS}). Each paper is graded as soon as it arrives.`
          : `Then drop your students' ${noun} here: one file per student, or one scan of the whole class.`}
        buttonLabel="Choose files"
        inputId="workspace-papers-drop"
      />

      {pending && (
        <DetectedPanel
          pending={pending}
          keyPageCount={keyPageCount}
          onePassAvailable={onePassAvailable}
          onSwitch={() => setPending({ ...pending, mode: pending.mode === "packet" ? "per_student" : "packet" })}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      )}

      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {packetDone && (
          <Alert tone="success" title="The class's scan is uploaded">
            The AI finds each student&apos;s paper in <span className="break-all">{packetDone.name}</span> and grades it; the papers appear
            below as they are graded. <Link href={packetDone.reviewUrl}>Follow the scan</Link>
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>

      <UploadList assignmentId={assignmentId} uploads={uploads} resultsLink={false} compactWhenDone />

      <p className="text-sm text-muted">
        Need to split a scan every few pages, or check the split first?{" "}
        <Link href={`/teacher/assignments/${assignmentId}/upload`}>More ways to upload</Link>
      </p>
    </>
  );
}

function DetectedPanel(props: {
  pending: Pending;
  keyPageCount: number | null;
  onePassAvailable: boolean;
  onSwitch: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { pending, keyPageCount, onePassAvailable, onSwitch, onConfirm, onCancel } = props;
  const packet = pending.mode === "packet";
  const chosen = pending.mode !== pending.guess.mode;
  const size = `${pending.pageCount !== null ? `${plural(pending.pageCount, "page")}, ` : ""}${formatBytes(pending.file.size)}`;
  return (
    <section aria-labelledby="detected-heading" className="flex flex-col gap-3 rounded-xl border border-brand-100 bg-brand-50 p-4">
      <div className="flex flex-col gap-1">
        <h3 id="detected-heading" className="text-base font-semibold" aria-live="polite">
          {packet ? "The whole class in one scan" : "One student's paper"}
        </h3>
        <p className="text-sm">
          <span className="break-all font-medium">{pending.file.name}</span> <span className="text-muted">({size})</span>
        </p>
        <p className="text-sm text-muted">
          {chosen ? "You switched this." : pending.guess.why}{" "}
          {packet
            ? onePassAvailable
              ? "The AI finds where each student's paper starts and grades it in the same pass; papers it isn't sure about are flagged for you."
              : "The AI finds where each student's paper starts, then grades each one."
            : `It is graded as one paper${keyPageCount !== null ? ` (the key has ${plural(keyPageCount, "page")})` : ""}.`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onConfirm}>{packet ? "Grade the whole class" : "Grade this paper"}</Button>
        <Button variant="secondary" onClick={onSwitch}>
          {packet ? "Treat as one student's paper instead" : "This is the whole class"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  );
}
