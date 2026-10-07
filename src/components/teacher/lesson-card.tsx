"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { addLessonToPreferencesAction, deleteLessonAction, setLessonActiveAction, updateLessonReasonAction } from "@/actions/lessons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { TONE_CLASSES } from "@/components/ui/tone";
import { ATTEMPT_LABEL, CORRECTNESS_LABEL, formatPoints } from "@/lib/format";
import type { Attempt, Correctness, LessonNotSentReason, LessonView } from "@/lib/types";
import { leaveUnsavedMessage, orderUnsaved } from "./unsaved-edits";
import { UnsavedEditsContext, useReportUnsaved, useUnsavedEditsTracker } from "./unsaved-edits-context";
import { useActionRunner } from "./use-action-runner";
import { useLeaveGuard } from "./use-leave-guard";
import { useSyncedState } from "./use-synced-state";

const NOT_SENT_TEXT: Record<Exclude<LessonNotSentReason, "inactive" | "unknown_item">, string> = {
  agrees: "Not sent: same as the AI's judgment, with no reason",
  no_reading: "Not sent: the AI never read this answer",
  limit: "Not sent: only the newest lessons fit",
};

function judgmentText(attempt: Attempt, correctness: Correctness): string {
  return `${ATTEMPT_LABEL[attempt]} · ${CORRECTNESS_LABEL[correctness]}`;
}

function rulingText({ lesson, itemMaxCenti }: LessonView): string {
  const { aiAttempt, aiCorrectness, teacherAttempt, teacherCorrectness, overrideCenti } = lesson;
  if (overrideCenti === null && teacherAttempt === aiAttempt && teacherCorrectness === aiCorrectness) return "Same as the AI";
  const judgment = teacherAttempt && teacherCorrectness ? judgmentText(teacherAttempt, teacherCorrectness) : "";
  const points = overrideCenti === null ? "" : ` — you gave ${formatPoints(overrideCenti)} of ${formatPoints(itemMaxCenti)} pts`;
  return `${judgment}${points}`;
}

function lessonFormKey(lessonId: string): string {
  return `lesson:${lessonId}`;
}

/**
 * Collects the lesson cards' unsaved reasons, so a link away from the Lessons tab asks first.
 * `lessonIds` lists the cards top to bottom.
 */
export function LessonListGuard({ lessonIds, children }: { lessonIds: string[]; children: ReactNode }) {
  const [unsavedForms, tracker] = useUnsavedEditsTracker();
  const unsaved = orderUnsaved(unsavedForms, lessonIds.map(lessonFormKey));
  useLeaveGuard(unsaved.length > 0, leaveUnsavedMessage(unsaved));
  return <UnsavedEditsContext value={tracker}>{children}</UnsavedEditsContext>;
}

/** One correction the teacher made, as the grader sees it, with the teacher's reason and controls. */
export function LessonCard({ entry }: { entry: LessonView }) {
  const { lesson } = entry;
  const runner = useActionRunner();
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason, expectSaved] = useSyncedState(lesson.reason);
  const dirty = reason !== lesson.reason;
  const reasonId = `lesson-${lesson.id}-reason`;
  useReportUnsaved(lessonFormKey(lesson.id), `the reason for Question ${entry.itemLabel}`, dirty);

  function saveReason(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    expectSaved();
    runner.run(() => updateLessonReasonAction(lesson.id, reason), undefined, () => expectSaved(false));
  }

  function setActive(active: boolean) {
    setMessage(null);
    runner.run(() => setLessonActiveAction(lesson.id, active));
  }

  function addToPreferences() {
    setMessage(null);
    runner.run(
      () => addLessonToPreferencesAction(lesson.id),
      (result) => setMessage(result.data?.added ? "Added to your grading preferences." : "Already in your grading preferences."),
    );
  }

  function remove() {
    if (!window.confirm("Delete this lesson? The grader stops using it. Your points and feedback on the paper stay as they are.")) return;
    setMessage(null);
    runner.run(() => deleteLessonAction(lesson.id));
  }

  const hasReason = lesson.reason.trim() !== "";
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
      <LessonBadges entry={entry} />

      <dl className="grid gap-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-2">
        <dt className="font-medium text-muted">Student&apos;s answer</dt>
        <dd className="whitespace-pre-wrap rounded-md bg-subtle px-2 py-1 font-mono text-[13px]">{lesson.studentAnswer || "(blank)"}</dd>
        <dt className="font-medium text-muted">AI judged</dt>
        <dd>
          {lesson.aiAttempt && lesson.aiCorrectness ? judgmentText(lesson.aiAttempt, lesson.aiCorrectness) : "No AI judgment"}
        </dd>
        <dt className="font-medium text-muted">Your ruling</dt>
        <dd>{rulingText(entry)}</dd>
      </dl>
      {lesson.feedback?.trim() && <p className="whitespace-pre-wrap text-sm">Your feedback: {lesson.feedback}</p>}
      {lesson.whatStudentDid?.trim() && (
        <p className="whitespace-pre-wrap text-sm">Your “What you did”: {lesson.whatStudentDid}</p>
      )}

      <form onSubmit={saveReason} className="flex flex-col gap-1.5 border-t border-line pt-3">
        <label htmlFor={reasonId} className="text-sm font-medium">
          Why? The grader learns from this.
        </label>
        <Textarea
          id={reasonId}
          rows={2}
          maxLength={1000}
          className="sm:text-sm"
          readOnly={runner.pending}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" className="self-start" disabled={!dirty || runner.pending}>
          Save reason
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={runner.pending} onClick={() => setActive(!lesson.active)}>
          {lesson.active ? "Turn off" : "Turn on"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasReason || runner.pending}
          title={hasReason ? undefined : "Write a reason first"}
          onClick={addToPreferences}
        >
          Add to my grading preferences
        </Button>
        <Button variant="danger" size="sm" disabled={runner.pending} onClick={remove}>
          Delete
        </Button>
        {entry.paperHref && (
          <Link href={entry.paperHref} className="flex min-h-11 items-center px-1 text-sm sm:min-h-9">
            Open the paper
          </Link>
        )}
        {runner.pending && <Spinner label="Working…" className="size-4" />}
      </div>
      <p role="status" className="text-sm text-success-800 empty:hidden">
        {message}
      </p>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </article>
  );
}

/** "Off", or why an active lesson is not sent to the grader; nothing for a lesson the grader reads. */
function LessonBadges({ entry }: { entry: LessonView }) {
  const { notSent } = entry;
  if (!entry.lesson.active) return <Badge tone="neutral" className="self-start">Off</Badge>;
  if (notSent === null || notSent === "inactive" || notSent === "unknown_item") return null;
  // A Badge never wraps, and these are too long for a phone's width.
  return (
    <span className={cx("self-start rounded-2xl border px-2.5 py-0.5 text-xs font-medium", TONE_CLASSES.warning)}>
      {NOT_SENT_TEXT[notSent]}
    </span>
  );
}
