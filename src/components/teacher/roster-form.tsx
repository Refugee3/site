"use client";

import { useState, type FormEvent } from "react";
import { copyPreviousRosterAction, saveRosterAction } from "@/actions/roster";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { RosterView } from "@/lib/services/rosters";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";
import { useSyncedState } from "./use-synced-state";

export interface RosterFormProps {
  assignmentId: string;
  view: RosterView;
}

/**
 * The class list (Settings tab): one student per line, optionally "Name | Period 3". Names read on papers are matched to it,
 * so a hard-to-read name gets the list's spelling (and section); one that matches no one, or could be two students, is
 * flagged for a check.
 */
export function RosterForm({ assignmentId, view }: RosterFormProps) {
  const [text, setText, expectSaved] = useSyncedState(view.text);
  const [saved, setSaved] = useState(false);
  const runner = useActionRunner();
  const dirty = text !== view.text;
  const inputId = `roster-${assignmentId}`;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    expectSaved();
    runner.run(() => saveRosterAction(assignmentId, text), () => setSaved(true), () => expectSaved(false));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor={inputId} className="flex flex-col gap-1">
        <span className="text-sm font-medium">Students (one per line; add a section after a bar: “Maria Lopez | Period 3”)</span>
        <Textarea
          id={inputId}
          rows={8}
          maxLength={40_000}
          readOnly={runner.pending}
          value={text}
          placeholder={"Maria Lopez | Period 3\nJames Brown | Period 4"}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="text-sm text-muted">
        Names read on papers are matched to this list, also when they&apos;re misspelt, reversed or only a first name; the list&apos;s
        spelling and section are then used. A name that matches no one, or could be two students, is flagged for you to check.
        The AI only sees these names when it reads a name.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={!dirty || runner.pending}>
          {runner.pending && <Spinner className="size-4" />}
          Save class list
        </Button>
        {view.previous && view.count === 0 && !dirty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={runner.pending}
            onClick={() => runner.run(() => copyPreviousRosterAction(assignmentId), () => setSaved(true))}
          >
            Use the list from “{view.previous.title}” ({plural(view.previous.count, "student")})
          </Button>
        )}
        <p role="status" className="text-sm text-muted">
          {saved && !dirty ? `Saved: ${plural(view.count, "student")}.` : view.count > 0 ? plural(view.count, "student") : "No class list yet."}
        </p>
      </div>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </form>
  );
}
