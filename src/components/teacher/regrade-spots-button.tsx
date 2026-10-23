"use client";

import { useState } from "react";
import { regradeWithSpotsAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";

export interface RegradeSpotsButtonProps {
  assignmentId: string;
  /** Current graded papers whose circled answers weren't read from the blank worksheet's latest saved answer spots. */
  count: number;
}

/**
 * Regrades the papers graded before the teacher saved the blank worksheet's answer spots (or with an earlier save), so their
 * circled answers are read from the ink marks. Shows only while there are such papers; its result stays on screen after the
 * regrade brings the count back to zero. The grading progress shows as for any regrade.
 */
export function RegradeSpotsButton({ assignmentId, count }: RegradeSpotsButtonProps) {
  const runner = useActionRunner();
  const [message, setMessage] = useState<string | null>(null);

  if (count === 0 && message === null && runner.error === null) return null;

  function regrade() {
    const papers = plural(count, "paper");
    const question = `Regrade ${papers} using the blank worksheet? Circled answers will be re-read from the ink marks. Your own point changes are kept.`;
    if (!window.confirm(question)) return;
    setMessage(null);
    runner.run(
      () => regradeWithSpotsAction(assignmentId),
      (result) => setMessage(`${plural(result.data?.count ?? 0, "paper")} queued for regrading.`),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {count > 0 && (
          <Button variant="primary" size="sm" disabled={runner.pending} onClick={regrade}>
            {runner.pending && <Spinner className="size-4" />}
            Regrade {plural(count, "paper")} with mark detection
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
