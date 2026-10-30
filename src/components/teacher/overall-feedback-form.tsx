"use client";

import { useState, type FormEvent } from "react";
import { setOverallFeedbackAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useReportUnsaved } from "./unsaved-edits-context";
import { useActionRunner } from "./use-action-runner";
import { useSyncedState } from "./use-synced-state";

export interface OverallFeedbackFormProps {
  submissionId: string;
  overallFeedback: string;
  /** The teacher has edited it before, so regrades keep the teacher's version. */
  edited: boolean;
  /** A project: the field holds the AI's review (longer), labelled as such. */
  project?: boolean;
}

/** The note about the whole paper, for the student; it is in the grades CSV ("Overall feedback"). */
export function OverallFeedbackForm({ submissionId, overallFeedback, edited, project = false }: OverallFeedbackFormProps) {
  const [text, setText, expectSaved] = useSyncedState(overallFeedback);
  const [saved, setSaved] = useState(false);
  const runner = useActionRunner();
  const inputId = `overall-feedback-${submissionId}`;
  const dirty = text !== overallFeedback;
  useReportUnsaved("overall", "Overall feedback", dirty);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    expectSaved();
    runner.run(
      () => setOverallFeedbackAction(submissionId, text),
      () => setSaved(true),
      () => expectSaved(false),
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm font-medium">
        {project ? "The AI's review (edit it before sharing; included in the grades CSV)" : "Overall feedback (included in the grades CSV)"}
      </label>
      <Textarea
        id={inputId}
        rows={project ? 14 : 4}
        maxLength={project ? 20_000 : 2000}
        readOnly={runner.pending}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={!dirty || runner.pending}>
          {runner.pending && <Spinner className="size-4" />}
          Save feedback
        </Button>
        <p role="status" className="text-sm text-muted">
          {saved && !dirty ? "Saved. Regrades keep your version." : edited ? "Edited by you; regrades keep your version." : null}
        </p>
      </div>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </form>
  );
}
