"use client";

import { useState } from "react";
import { renameAssignmentAction } from "@/actions/assignments";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useActionRunner } from "./use-action-runner";

export interface EditableTitleProps {
  assignmentId: string;
  title: string;
  /** The title is still "Untitled …" (shown muted). */
  placeholder: boolean;
  /** A short note beside it ("The AI names it once it has read the key."). */
  note?: string | null;
}

/** The assignment's heading, renamed in place ("Rename" → a text field → Save). */
export function EditableTitle({ assignmentId, title, placeholder, note }: EditableTitleProps) {
  const runner = useActionRunner();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  function start() {
    setDraft(placeholder ? "" : title);
    setEditing(true);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    runner.run(() => renameAssignmentAction(assignmentId, draft), () => setEditing(false));
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex w-full min-w-0 flex-col gap-2">
        <label htmlFor="assignment-title" className="sr-only">Title</label>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <Input
              id="assignment-title"
              autoFocus
              maxLength={200}
              placeholder="e.g. Unit 4 Quiz"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              className="text-lg font-semibold"
            />
          </div>
          <Button type="submit" disabled={runner.pending}>
            {runner.pending && <Spinner className="size-4" />}
            Save
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={runner.pending}>
            Cancel
          </Button>
        </div>
        {runner.error && <Alert tone="danger">{runner.error}</Alert>}
      </form>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <h1 className={placeholder ? "min-w-0 break-words text-2xl font-semibold text-muted" : "min-w-0 break-words text-2xl font-semibold"}>
        {title}
      </h1>
      <Button variant="ghost" size="sm" onClick={start} aria-label={`Rename ${title}`}>
        Rename
      </Button>
      {note && <span className="text-sm text-muted">{note}</span>}
    </div>
  );
}
