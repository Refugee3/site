"use client";

import { useState } from "react";
import { regradeWithGuidanceAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";

export interface RegradeGuidanceButtonProps {
  assignmentId: string;
  /** Unreviewed papers graded before the latest lessons or grading preferences. */
  count: number;
}

/**
 * Regrades the papers that haven't seen the teacher's latest corrections yet. The button shows only while
 * there are such papers; its result stays on screen after the regrade brings the count back to zero.
 */
export function RegradeGuidanceButton({ assignmentId, count }: RegradeGuidanceButtonProps) {
  const runner = useActionRunner();
  const [message, setMessage] = useState<string | null>(null);

  if (count === 0 && message === null && runner.error === null) return null;

  function regrade() {
    const question = `Regrade ${plural(count, "paper")} you haven't reviewed yet, using your latest lessons and grading preferences? Your overrides and edits are kept.`;
    if (!window.confirm(question)) return;
    setMessage(null);
    runner.run(
      () => regradeWithGuidanceAction(assignmentId),
      (result) => setMessage(`${plural(result.data?.count ?? 0, "paper")} queued for regrading.`),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {count > 0 && (
          <Button variant="secondary" size="sm" disabled={runner.pending} onClick={regrade}>
            {runner.pending && <Spinner className="size-4" />}
            Regrade {plural(count, "paper")} with your latest corrections
          </Button>
        )}
        <p role="status" className="text-sm text-muted empty:hidden">
          {message}
        </p>
      </div>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </div>
  );
}
