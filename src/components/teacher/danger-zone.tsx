"use client";

import { useActionState, useState } from "react";
import { deleteAssignmentAction } from "@/actions/assignments";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/types";

export interface DangerZoneProps {
  assignmentId: string;
  title: string;
}

/** Deleting the assignment, confirmed by typing its title. */
export function DangerZone({ assignmentId, title }: DangerZoneProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    deleteAssignmentAction.bind(null, assignmentId),
    null,
  );
  // Controlled so a failed attempt keeps what was typed (React resets uncontrolled fields after an action).
  const [confirmTitle, setConfirmTitle] = useState("");
  const failure = state && !state.ok ? state : null;
  const matches = confirmTitle.trim() === title.trim();

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <h3 className="font-semibold text-danger-700">Delete this assignment</h3>
      <p className="text-sm text-muted">
        Deletes the answer key, every paper, and all grades and feedback. This can&apos;t be undone. Download the grades
        (CSV) from the Results tab first if you need them.
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
