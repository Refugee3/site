"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { kindNoun } from "@/lib/format";
import type { AssignmentLiveSnapshot } from "@/lib/live/snapshot";
import { plural } from "../text";
import { useEventSource } from "../use-event-source";
import { GradingBody } from "./grading-card";
import { KeyCardBody } from "./key-card";
import { WorkspaceStep, type StepState } from "./step";
import { StudentsWorkBody } from "./students-work-card";

export interface LiveWorkspaceProps {
  /** The snapshot the page was rendered with (newer than any streamed one after a refresh). */
  initial: AssignmentLiveSnapshot;
  /** keyPageCountHint: the pages of one student's paper, when the key tells (else the key PDF's own page count is used). */
  keyPageCount: number | null;
  onePassAvailable: boolean;
}

/** Polling instead, when the browser can't keep the live connection, while anything is moving. */
const FALLBACK_POLL_MS = 3000;
/** Several changes in a burst (a stack of papers finishing) re-render the server-rendered parts once. */
const REFRESH_DEBOUNCE_MS = 700;

/**
 * The assignment's workspace: answer key → students' work → grading, one card each, updated in place from the live stream
 * (GET /api/teacher/assignments/[id]/live). The results board and the header below and above are server-rendered; when the
 * stream reports a change they show (a paper finished, the AI named the assignment), the page re-renders them in place. If the
 * browser can't keep the stream open, the page polls instead.
 */
export function LiveWorkspace({ initial, keyPageCount, onePassAvailable }: LiveWorkspaceProps) {
  const router = useRouter();
  const id = initial.assignment.id;
  const [streamed, setStreamed] = useState<AssignmentLiveSnapshot | null>(null);
  const { failed } = useEventSource<AssignmentLiveSnapshot>(`/api/teacher/assignments/${id}/live`, setStreamed);
  const snapshot = streamed !== null && streamed.serverNow >= initial.serverNow ? streamed : initial;

  // Re-render the server-rendered parts (board, header, tabs) when what they show changed.
  const serverKey = serverRenderedKey(snapshot);
  const shownKey = useRef(serverKey);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (serverKey === shownKey.current) return;
    shownKey.current = serverKey;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
  }, [serverKey, router]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const { key, counts, progress, scans } = snapshot;
  const pendingQuestions = snapshot.questions.filter((q) => q.status === "pending").length;
  const keyState: StepState = key.approved ? "done" : "current";
  const papersState: StepState = !key.approved ? "waiting" : counts.total > 0 || scans.length > 0 ? "done" : "current";
  const gradingActive = progress !== null || scans.some((s) => s.status === "splitting");
  const gradingState: StepState = counts.total === 0 && scans.length === 0 ? "waiting" : gradingActive || counts.needs_review > 0 ? "current" : "done";
  const busy = key.status === "processing" || gradingActive;
  const noun = kindNoun(snapshot.assignment.kind, true);

  return (
    <div className="flex flex-col">
      {/* Status changes only (never the ticking timers), read out once each. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement(snapshot)}</p>

      <WorkspaceStep number={1} id="key" title="Answer key" state={keyState} status={keyStatusLine(snapshot, pendingQuestions)}>
        <KeyCardBody assignmentId={id} keyState={key} questions={snapshot.questions} serverNow={snapshot.serverNow} />
      </WorkspaceStep>

      <WorkspaceStep
        number={2}
        id="papers"
        title="Students' work"
        state={papersState}
        status={counts.total > 0 ? `${plural(counts.total, "paper")} uploaded` : key.approved ? "Ready for your students' work" : "After the key is approved"}
      >
        <StudentsWorkBody
          assignmentId={id}
          keyApproved={key.approved}
          keyPageCount={keyPageCount ?? key.pageCount}
          onePassAvailable={onePassAvailable}
          noun={noun}
        />
      </WorkspaceStep>

      <WorkspaceStep number={3} id="grading" title="Grading" state={gradingState} status={gradingStatusLine(snapshot)} last>
        <GradingBody snapshot={snapshot} assignmentId={id} />
      </WorkspaceStep>

      {failed && <AutoRefresh intervalMs={busy ? FALLBACK_POLL_MS : null} />}
    </div>
  );
}

/** What the server-rendered parts of the page show; when it changes, they are re-rendered. */
function serverRenderedKey(s: AssignmentLiveSnapshot): string {
  return JSON.stringify([
    s.assignment.title,
    s.key.status, s.key.approved, s.key.itemCount, s.key.totalPointsCenti, s.key.updatedAt,
    s.counts,
    s.recentPapers.map((p) => [p.submissionId, p.status, p.scoreEarnedCenti, p.name, p.section]),
    s.struggling.map((q) => [q.itemId, q.missedTenths]),
    s.scans.map((scan) => [scan.id, scan.status, scan.papers]),
  ]);
}

function keyStatusLine(s: AssignmentLiveSnapshot, pendingQuestions: number): string {
  const { key } = s;
  if (key.approved) return "Approved";
  switch (key.status) {
    case "empty":
      return "Start here";
    case "processing":
      return "Being read…";
    case "failed":
      return "Couldn't be read";
    case "ready":
      return pendingQuestions > 0 ? `${plural(pendingQuestions, "question")} for you` : "Check and approve";
  }
}

function gradingStatusLine(s: AssignmentLiveSnapshot): string {
  const { progress, counts } = s;
  if (progress) return `${progress.done} of ${plural(progress.total, "paper")} done`;
  if (s.scans.some((scan) => scan.status === "splitting")) return "Reading the class's scan…";
  if (counts.total === 0) return "Nothing to grade yet";
  if (counts.needs_review > 0) return `${counts.needs_review} need${counts.needs_review === 1 ? "s" : ""} your check`;
  return "Up to date";
}

/** One sentence for screen readers on where things stand; it changes only when the status does. */
function announcement(s: AssignmentLiveSnapshot): string {
  const { key, progress, counts } = s;
  const pending = s.questions.filter((q) => q.status === "pending").length;
  const keyPart = key.approved
    ? "Answer key approved."
    : key.status === "processing"
      ? "Reading your answer key."
      : key.status === "failed"
        ? "The answer key couldn't be read."
        : key.status === "ready"
          ? pending > 0 ? `The AI has ${plural(pending, "question")} about your key.` : "Your answer key is ready to approve."
          : "";
  const gradingPart = progress
    ? `${progress.done} of ${plural(progress.total, "paper")} graded.`
    : counts.total > 0
      ? `${plural(counts.graded + counts.needs_review, "paper")} graded${counts.needs_review > 0 ? `, ${counts.needs_review} to check` : ""}.`
      : "";
  return [keyPart, gradingPart].filter(Boolean).join(" ");
}
