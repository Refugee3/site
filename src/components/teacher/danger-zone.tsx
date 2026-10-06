"use client";

import { useActionState, useState } from "react";
import { deleteAssignmentAction, rotateShareCodeAction } from "@/actions/assignments";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface DangerZoneProps {
  assignmentId: string;
  title: string;
}

/** Actions that break existing links or lose data: a new student code, and deleting the assignment. */
export function DangerZone({ assignmentId, title }: DangerZoneProps) {
  return (
    <div className="flex flex-col divide-y divide-line">
      <RotateCode assignmentId={assignmentId} />
      <DeleteAssignment assignmentId={assignmentId} title={title} />
    </div>
  );
}

function RotateCode({ assignmentId }: { assignmentId: string }) {
  const runner = useActionRunner();
  const [rotated, setRotated] = useState(false);

  function rotate() {
    if (!window.confirm("Make a new student code? The current code and link stop working immediately.")) return;
    setRotated(false);
    runner.run(() => rotateShareCodeAction(assignmentId), () => setRotated(true));
  }

  return (
    <section className="flex flex-col gap-2 pb-6">
      <h3 className="font-semibold">New student code</h3>
      <p className="text-sm text-muted">
        Use this if the code was shared where it shouldn&apos;t be. The old code and link stop working at once; papers
        already handed in and their receipt links are not affected.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={runner.pending} onClick={rotate}>
          {runner.pending && <Spinner className="size-4" />}
          Make a new code
        </Button>
        <p role="status" className="text-sm text-success-800">
          {rotated && "New code created — it's shown at the top of the page."}
        </p>
      </div>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </section>
  );
}

function DeleteAssignment({ assignmentId, title }: DangerZoneProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    deleteAssignmentAction.bind(null, assignmentId),
    null,
  );
  // Controlled so a failed attempt keeps what was typed (React resets uncontrolled fields after an action).
  const [confirmTitle, setConfirmTitle] = useState("");
  const failure = state && !state.ok ? state : null;
  const matches = confirmTitle.trim() === title.trim();

  return (
    <form action={formAction} className="flex flex-col gap-3 pt-6">
      <h3 className="font-semibold text-danger-700">Delete this assignment</h3>
      <p className="text-sm text-muted">
        Deletes the answer key, every paper, all grades and feedback, and the students&apos; receipt links. This can&apos;t
        be undone. Export the grades first if you need them.
      </p>
      {failure && !failure.fieldErrors && <Alert tone="danger">{failure.error}</Alert>}
      <Field
        label={
          <>
            Type the title to confirm: <span className="font-semibold">{title}</span>
          </>
        }
        htmlFor="delete-confirm-title"
        error={failure?.fieldErrors?.confirmTitle}
      >
        <Input
          id="delete-confirm-title"
          name="confirmTitle"
          autoComplete="off"
          value={confirmTitle}
          onChange={(e) => setConfirmTitle(e.target.value)}
        />
      </Field>
      <SubmitButton variant="danger" disabled={!matches} pendingText="Deleting…" className="self-start">
        Delete assignment
      </SubmitButton>
    </form>
  );
}
