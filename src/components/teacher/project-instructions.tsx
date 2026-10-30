"use client";

import Link from "next/link";
import { useState } from "react";
import { saveGradingInstructionsAction } from "@/actions/key";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { PROJECT_MODE_LABEL } from "@/lib/format";
import type { ProjectMode } from "@/lib/types";
import { FEEDBACK_INSTRUCTIONS_PLACEHOLDER, KEY_INSTRUCTIONS_PLACEHOLDER } from "./key-instructions-field";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";

/**
 * A project's "How to grade it" card: the instructions the AI reviews every project with (the key's grading instructions),
 * and how it grades (points or feedback only; changed in Settings). Saving changed instructions marks reviewed projects for
 * a regrade.
 */
export function ProjectInstructionsCard(p: {
  assignmentId: string; mode: ProjectMode; instructions: string; hasRubric: boolean; reviewedCount: number;
}) {
  const runner = useActionRunner();
  const [text, setText] = useState(p.instructions);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = text.trim() !== p.instructions;
  const missing = p.instructions === "" && !p.hasRubric;

  function save() {
    setSaved(null);
    runner.run(
      () => saveGradingInstructionsAction(p.assignmentId, { text }),
      (result) => {
        const stale = result.data?.staleCount ?? 0;
        setSaved(stale > 0 ? `Saved. ${plural(stale, "project")} reviewed before can be regraded from the Workspace tab.` : "Saved.");
      },
    );
  }

  return (
    <Card
      title="How to grade this project"
      actions={<Badge tone={p.mode === "feedback" ? "info" : "neutral"}>{PROJECT_MODE_LABEL[p.mode]}</Badge>}
    >
      <div className="flex flex-col gap-3">
        <label htmlFor="project-instructions" className="text-sm text-muted">
          {p.mode === "feedback"
            ? "Say what you want on each project: an analysis of each part, a summary, strengths and weaknesses, feedback for the student. No points are given."
            : p.hasRubric
              ? "The AI scores each rubric item below. Add anything else it should look for or how strict to be."
              : "Say what earns points and how many: the parts or criteria and what each is worth. Or upload a rubric below."}
        </label>
        <Textarea
          id="project-instructions"
          rows={5}
          maxLength={4000}
          value={text}
          disabled={runner.pending}
          placeholder={p.mode === "feedback" ? FEEDBACK_INSTRUCTIONS_PLACEHOLDER : KEY_INSTRUCTIONS_PLACEHOLDER}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(null);
          }}
        />
        {missing && !dirty && (
          <Alert tone="warning">Write the instructions (or upload a rubric) before uploading projects.</Alert>
        )}
        {runner.error && <Alert tone="danger">{runner.error}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={!dirty || runner.pending} onClick={save}>
            {runner.pending && <Spinner className="size-4" />}
            Save instructions
          </Button>
          <p role="status" className="text-sm text-muted">
            {runner.pending ? "Saving…" : dirty ? "Unsaved changes." : saved}
          </p>
        </div>
        <p className="text-sm text-muted">
          {p.mode === "feedback" ? "Want scores instead?" : "Want feedback without points?"}{" "}
          <Link href={`/teacher/assignments/${p.assignmentId}/settings`}>Change how projects are graded in Settings</Link>
          {p.reviewedCount > 0 && " (reviewed projects can then be regraded)"}.
        </p>
      </div>
    </Card>
  );
}
