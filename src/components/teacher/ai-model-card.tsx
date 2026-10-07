"use client";

import { useOptimistic, useState } from "react";
import { setAiModelAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { AI_MODEL_NAME } from "@/lib/ai-models";
import type { AiModel } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface AiModelCardProps {
  model: AiModel;
}

const MODEL_OPTIONS: Array<{ value: AiModel; recommended: boolean; hint: string }> = [
  { value: "claude-sonnet-5-5", recommended: true, hint: "About half the cost. Good for most homework." },
  {
    value: "claude-opus-5-5",
    recommended: false,
    hint: "The most capable model — best for messy handwriting or tricky answers. About twice the cost of Sonnet.",
  },
];

/** Settings → AI model: which Claude model reads answer keys and grades papers, with either engine. */
export function AiModelCard({ model }: AiModelCardProps) {
  const runner = useActionRunner();
  // The choice moves at once; it settles on the stored value when the action and refresh finish (or fail).
  const [shownModel, setShownModel] = useOptimistic(model);
  const [saved, setSaved] = useState<string | null>(null);

  function choose(next: AiModel) {
    setSaved(null);
    runner.run(() => {
      setShownModel(next);
      return setAiModelAction(next);
    }, (result) => setSaved(result.message ?? null));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Pick the Claude model that reads and grades papers. You can switch any time; papers already graded keep their grades.
      </p>
      <fieldset disabled={runner.pending} className="flex min-w-0 flex-col gap-2">
        <legend className="sr-only">AI model</legend>
        {MODEL_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer gap-3 rounded-lg border border-line-strong bg-surface p-3 has-checked:border-brand-600 has-checked:bg-brand-50"
          >
            <input
              type="radio"
              name="ai-model"
              value={option.value}
              checked={shownModel === option.value}
              onChange={() => choose(option.value)}
              className="mt-0.5 size-5 shrink-0 accent-brand-600"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {AI_MODEL_NAME[option.value]}
                {option.recommended && <Badge tone="info">Recommended</Badge>}
                {runner.pending && shownModel === option.value && <Spinner className="size-4" />}
              </span>
              <span className="text-sm text-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p role="status" className="text-sm text-success-800 empty:hidden">
        {saved}
      </p>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
      <p className="text-xs text-muted">Splitting whole-class scans always uses Sonnet 5.5.</p>
    </div>
  );
}
