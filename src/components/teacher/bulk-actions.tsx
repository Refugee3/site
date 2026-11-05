"use client";

import { useState } from "react";
import { regradeStaleAction, retryFailedAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/ui/link-button";
import { Spinner } from "@/components/ui/spinner";
import { RegradeGuidanceButton } from "./regrade-guidance-button";
import { RegradeSpotsButton } from "./regrade-spots-button";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";

export interface BulkActionsProps {
  assignmentId: string;
  /** Papers graded against an earlier key revision. */
  staleCount: number;
  /** Unreviewed papers graded before the latest lessons or grading preferences. */
  guidanceStaleCount: number;
  /** Papers whose circled answers weren't read from the blank worksheet's latest saved answer spots. */
  spotsStaleCount: number;
  failedCount: number;
  /** A project: no per-question stats to download, and stale means reviewed with earlier instructions. */
  project?: boolean;
  hasPapers: boolean;
}

/**
 * Whole-assignment actions above the board: regrade stale papers, those graded before the blank worksheet's answer spots
 * were saved or before the latest corrections, retry failed ones, export grades.
 */
export function BulkActions(props: BulkActionsProps) {
  const { assignmentId, staleCount, guidanceStaleCount, spotsStaleCount, failedCount, hasPapers, project = false } = props;
  const runner = useActionRunner();
  const [message, setMessage] = useState<string | null>(null);

  function regradeStale() {
    const question = project
      ? `Review ${plural(staleCount, "project")} again with your new instructions? Your edits to the reviews are kept.`
      : `Regrade ${plural(staleCount, "paper")} graded with an earlier version of the answer key? Your overrides and edits are kept.`;
    if (!window.confirm(question)) return;
    setMessage(null);
    runner.run(
      () => regradeStaleAction(assignmentId),
      (result) => setMessage(`${plural(result.data?.count ?? 0, "paper")} queued for regrading.`),
    );
  }

  function retryFailed() {
    setMessage(null);
    runner.run(
      () => retryFailedAction(assignmentId),
      (result) => setMessage(`${plural(result.data?.count ?? 0, "paper")} queued to try again.`),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {staleCount > 0 && (
          <Button
            variant="secondary"
            size="sm"
            disabled={runner.pending}
            onClick={regradeStale}
            title={project ? "These projects were reviewed before you changed how to grade them." : "These papers were graded before you changed the answer key."}
          >
            Regrade stale ({staleCount})
          </Button>
        )}
        {failedCount > 0 && (
          <Button variant="secondary" size="sm" disabled={runner.pending} onClick={retryFailed}>
            Retry failed ({failedCount})
          </Button>
        )}
        {hasPapers && (
          <LinkButton href={`/api/teacher/assignments/${assignmentId}/export`} variant="secondary" size="sm" download>
            Download grades (CSV)
          </LinkButton>
        )}
        {hasPapers && !project && (
          <LinkButton href={`/api/teacher/assignments/${assignmentId}/export/questions`} variant="secondary" size="sm" download>
            Download question stats (CSV)
          </LinkButton>
        )}
        {runner.pending && <Spinner label="Working…" className="size-4" />}
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      </div>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
      <RegradeSpotsButton assignmentId={assignmentId} count={spotsStaleCount} />
      <RegradeGuidanceButton assignmentId={assignmentId} count={guidanceStaleCount} />
    </div>
  );
}
