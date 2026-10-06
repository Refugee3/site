"use client";

import { useState, type FormEvent } from "react";
import { setTotalOverrideAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatPercent, formatPoints } from "@/lib/format";
import type { ScoreResult } from "@/lib/types";
import { parsePointsOverride, pointsInputText, shareTenths } from "./points";
import { useActionRunner } from "./use-action-runner";
import { useSyncedState } from "./use-synced-state";

export interface ScoreSummaryProps {
  submissionId: string;
  score: ScoreResult;
  totalOverrideCenti: number | null;
  itemCount: number;
}

/** The paper's score with its completion and accuracy breakdown, and the teacher's total override. */
export function ScoreSummary({ submissionId, score, totalOverrideCenti, itemCount }: ScoreSummaryProps) {
  const stored = pointsInputText(totalOverrideCenti);
  const [text, setText] = useSyncedState(stored);
  const [inputError, setInputError] = useState<string | null>(null);
  const runner = useActionRunner();
  const inputId = `total-override-${submissionId}`;

  function save(value: string) {
    const parsed = parsePointsOverride(value, score.maxCenti);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    setInputError(null);
    runner.run(() => setTotalOverrideAction(submissionId, parsed.centi));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save(text);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-semibold tabular-nums">
          {formatPoints(score.earnedCenti)} / {formatPoints(score.maxCenti)}
        </span>
        <span className="text-muted">points</span>
        <span className="text-xl font-semibold tabular-nums text-muted">{formatPercent(score.percentTenths)}</span>
        {score.totalOverridden && <Badge tone="info">Total set by you</Badge>}
      </p>
      <p className="text-sm text-muted">
        Completion {formatPercent(shareTenths(score.completionCenti, score.maxCenti))} · Accuracy{" "}
        {formatPercent(shareTenths(score.accuracyCenti, score.maxCenti))} · {score.judgedCount} of {itemCount} items judged by
        the AI
      </p>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            Total override
          </label>
          <div className="flex items-center gap-2">
            <div className="w-24">
              <Input
                id={inputId}
                inputMode="decimal"
                placeholder="—"
                aria-invalid={inputError ? true : undefined}
                className="sm:min-h-9 sm:text-sm"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <span className="text-sm text-muted">/ {formatPoints(score.maxCenti)}</span>
          </div>
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={text === stored || runner.pending}>
          {runner.pending && <Spinner className="size-4" />}
          Save total
        </Button>
        {totalOverrideCenti !== null && (
          <Button
            variant="ghost"
            size="sm"
            disabled={runner.pending}
            onClick={() => {
              setText("");
              save("");
            }}
          >
            Clear
          </Button>
        )}
      </form>
      <p className="text-xs text-muted">Replaces the sum of the item points. Leave it empty to use the sum.</p>
      {(inputError || runner.error) && <Alert tone="danger">{inputError ?? runner.error}</Alert>}
    </div>
  );
}
