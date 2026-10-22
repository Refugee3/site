"use client";

import { findSpotsAgainAction, removeWorksheetAction } from "@/actions/worksheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useActionRunner } from "../use-action-runner";
import { WorksheetUpload } from "./worksheet-upload";

/** Finding the spots again (from the text, or by the AI), replacing the blank, removing it. */
export function WorksheetActions(props: { assignmentId: string; hasText: boolean; canAskAi: boolean; uploadUrl: string }) {
  const { assignmentId, hasText, canAskAi, uploadUrl } = props;
  const runner = useActionRunner();
  const again = (ai: boolean) => {
    if (!window.confirm("Find the answer spots again? Your changes to them are replaced.")) return;
    runner.run(() => findSpotsAgainAction(assignmentId, ai));
  };
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer font-medium">Find again, replace or remove the blank</summary>
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {hasText && (
            <Button variant="secondary" size="sm" disabled={runner.pending} onClick={() => again(false)}>
              Find the spots again from the text
            </Button>
          )}
          {canAskAi && (
            <Button variant="secondary" size="sm" disabled={runner.pending} onClick={() => again(true)}>
              Ask the AI to find the spots
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={runner.pending}
            onClick={() => {
              if (window.confirm("Remove the blank worksheet? Papers are then read by the AI alone.")) {
                runner.run(() => removeWorksheetAction(assignmentId));
              }
            }}
          >
            Remove the blank worksheet
          </Button>
        </div>
        {runner.error && <Alert tone="danger">{runner.error}</Alert>}
        <WorksheetUpload
          uploadUrl={uploadUrl}
          title="Drop a different blank worksheet here"
          confirmText="Replace the blank worksheet? Its answer spots are found again."
        />
      </div>
    </details>
  );
}
