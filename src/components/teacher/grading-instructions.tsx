"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { saveGradingInstructionsAction } from "@/actions/key";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { UploadPageView } from "@/lib/types";
import { gradedUnder, gradingScopeFromText } from "./grading-scope";
import { listText, plural } from "./text";
import { useActionRunner } from "./use-action-runner";

type Instructions = NonNullable<UploadPageView["instructions"]>;

/**
 * The upload page's "Grading instructions" box: what the AI should look for on every paper ("Grade the work on 3, not just the
 * answer"). It is the same text as the answer key's grading instructions. When the text says which questions to grade ("Only
 * grade 2, 4b and 5", "Skip 1"), saving also sets which questions count, like the key's "Grade this" boxes.
 */
export function GradingInstructions({ assignmentId, instructions }: { assignmentId: string; instructions: Instructions }) {
  const runner = useActionRunner();
  const [text, setText] = useState(instructions.text);
  const [saved, setSaved] = useState<string | null>(null);
  const { items } = instructions;
  const labels = useMemo(() => items.map((item) => item.label), [items]);
  const scope = useMemo(() => gradingScopeFromText(text, labels), [text, labels]);
  const scoped = scope ? gradedUnder(scope, labels) : null;
  // Only for edited text: ticking boxes on the key page later doesn't make saved instructions look unsaved here.
  const textChanged = text.trim() !== instructions.text;
  const scopeChanges = textChanged && scoped !== null && scoped.size > 0 && items.some((item) => item.graded !== scoped.has(item.label));
  const dirty = textChanged;
  const graded = items.filter((item) => item.graded);
  const skipped = items.filter((item) => !item.graded);
  const keyHref = `/teacher/assignments/${assignmentId}/key`;

  function save() {
    setSaved(null);
    const gradedItemIds = scopeChanges ? items.filter((item) => scoped?.has(item.label)).map((item) => item.id) : undefined;
    runner.run(
      () => saveGradingInstructionsAction(assignmentId, { text, gradedItemIds }),
      (result) => {
        const stale = result.data?.staleCount ?? 0;
        setSaved(stale > 0 ? `Saved. ${plural(stale, "paper")} graded before can be regraded from the Workspace tab.` : "Saved.");
      },
    );
  }

  return (
    <Card title="Grading instructions (optional)">
      <div className="flex flex-col gap-3">
        <label htmlFor="grading-instructions" className="text-sm text-muted">
          Tell the AI what to look for on every paper, e.g. “Only grade 2, 4b and 5”, “On 3, grade the work, not just the final
          answer”, or “Units are required”.
        </label>
        <Textarea
          id="grading-instructions"
          rows={3}
          maxLength={4000}
          value={text}
          disabled={runner.pending}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(null);
          }}
        />
        {textChanged && scoped && scoped.size === 0 && (
          <Alert tone="warning">These instructions would leave no question graded. Keep at least one counted.</Alert>
        )}
        {scopeChanges && scope && (
          <p className="rounded-md border border-line bg-subtle px-3 py-2 text-sm text-ink">
            Saving will {scope.mode === "only" ? "grade only" : "skip"} <span className="font-semibold">{listText(scope.labels)}</span>
            {scope.unknown.length > 0 && <span className="text-muted"> ({listText(scope.unknown)} not in the key)</span>}: {plural(scoped.size, "question")}{" "}
            counted out of {items.length}.
          </p>
        )}
        <p className="text-sm text-ink">
          Questions graded: <span className="font-semibold">{graded.length} of {items.length}</span>
          {skipped.length > 0 && <span className="text-muted"> (not graded: {listText(skipped.map((item) => item.label))})</span>}
          {" · "}
          <Link href={keyHref}>Choose in the answer key</Link>
        </p>
        {runner.error && <Alert tone="danger">{runner.error}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={!dirty || runner.pending || (textChanged && scoped !== null && scoped.size === 0)} onClick={save}>
            {runner.pending && <Spinner className="size-4" />}
            Save instructions
          </Button>
          <p role="status" className="text-sm text-muted">
            {runner.pending ? "Saving…" : dirty ? "Unsaved changes." : saved}
          </p>
        </div>
      </div>
    </Card>
  );
}
