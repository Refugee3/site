"use client";

import Link from "next/link";
import { useOptimistic } from "react";
import { setAssignmentStatusAction, setFeedbackReleasedAction } from "@/actions/assignments";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { AssignmentStatus } from "@/lib/types";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";

export interface LifecycleButtonsProps {
  assignmentId: string;
  status: AssignmentStatus;
  canOpen: boolean;
  keyApproved: boolean;
  released: boolean;
  needsReviewCount: number;
}

/** Open, close or reopen submissions, and release (or hide again) the students' feedback. */
export function LifecycleButtons(props: LifecycleButtonsProps) {
  const { assignmentId, status, canOpen, keyApproved, released, needsReviewCount } = props;
  const lifecycle = useActionRunner();
  const release = useActionRunner();

  const setStatus = (to: "open" | "closed") => lifecycle.run(() => setAssignmentStatusAction(assignmentId, to));
  // The switch moves at once; it settles on the stored value when the action and refresh finish (or fail).
  const [shownReleased, setShownReleased] = useOptimistic(released);
  const setReleased = (next: boolean) =>
    release.run(() => {
      setShownReleased(next);
      return setFeedbackReleasedAction(assignmentId, next);
    });

  return (
    <section aria-labelledby="lifecycle-heading" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h2 id="lifecycle-heading" className="text-sm font-semibold text-muted">
        Submissions and feedback
      </h2>

      <div className="flex flex-col gap-2">
        {status === "open" ? (
          <Button variant="secondary" disabled={lifecycle.pending} onClick={() => setStatus("closed")}>
            {lifecycle.pending && <Spinner className="size-4" />}
            Close submissions
          </Button>
        ) : (
          <Button disabled={!canOpen || lifecycle.pending} onClick={() => setStatus("open")}>
            {lifecycle.pending && <Spinner className="size-4" />}
            {status === "draft" ? "Open for students" : "Reopen submissions"}
          </Button>
        )}
        {!keyApproved && status !== "open" && (
          <p className="text-sm text-muted">
            Check and save the <Link href={`/teacher/assignments/${assignmentId}/key`}>answer key</Link> before opening.
          </p>
        )}
        {lifecycle.error && <Alert tone="danger">{lifecycle.error}</Alert>}
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            role="switch"
            checked={shownReleased}
            disabled={release.pending}
            onChange={(e) => setReleased(e.target.checked)}
            className="size-5 shrink-0 accent-brand-600"
          />
          <span className="font-medium">Students can see their feedback</span>
          {release.pending && <Spinner className="size-4" />}
        </label>
        <p className="text-sm text-warning-800">AI grades can be wrong — spot-check before releasing.</p>
        <p className="text-sm text-muted">
          {released
            ? "Graded papers show their score and notes on each student's receipt. Untick to hide them again."
            : "Until you release, receipts only confirm that the paper was received and read."}
          {needsReviewCount > 0 && ` ${plural(needsReviewCount, "paper")} awaiting your review stay hidden either way.`}
        </p>
        {release.error && <Alert tone="danger">{release.error}</Alert>}
      </div>
    </section>
  );
}
