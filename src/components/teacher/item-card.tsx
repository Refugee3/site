"use client";

import { useState, type FormEvent } from "react";
import { saveItemOverrideAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { Tone } from "@/components/ui/tone";
import { ANSWER_TYPE_LABEL, ATTEMPT_LABEL, CORRECTNESS_LABEL, formatPoints, REVIEW_REASON_LABEL } from "@/lib/format";
import type { Attempt, Confidence, Correctness, ItemJudgment, Legibility, ReviewItemView } from "@/lib/types";
import { parsePointsOverride, pointsInputText } from "./points";
import { useReportUnsaved } from "./unsaved-edits-context";
import { useActionRunner } from "./use-action-runner";
import { useSyncedState } from "./use-synced-state";

export interface ItemCardProps {
  submissionId: string;
  entry: ReviewItemView;
  /** Shows a page of the student's PDF next to the cards. */
  onShowPage: (page: number) => void;
}

const ATTEMPT_TONE: Record<Attempt, Tone> = { complete: "success", partial: "warning", none: "neutral" };

const CORRECTNESS_TONE: Record<Correctness, Tone> = {
  correct: "success",
  minor_error: "success",
  partially_correct: "warning",
  major_error: "danger",
  incorrect: "danger",
  no_answer: "neutral",
  cannot_judge: "warning",
};

const LEGIBILITY: Record<Legibility, { label: string; tone: Tone }> = {
  clear: { label: "Clear writing", tone: "neutral" },
  partly_illegible: { label: "Partly illegible", tone: "warning" },
  illegible: { label: "Illegible", tone: "danger" },
  no_writing: { label: "No writing", tone: "neutral" },
};

const CONFIDENCE: Record<Confidence, { label: string; tone: Tone }> = {
  high: { label: "High confidence", tone: "neutral" },
  medium: { label: "Medium confidence", tone: "neutral" },
  low: { label: "Low confidence", tone: "warning" },
};

/** Items the AI was unsure about, or asked the teacher to decide, are outlined in amber. */
function needsAttention(j: ItemJudgment | null): boolean {
  if (!j) return false;
  return j.confidence === "low" || j.reviewReason !== "none" || j.correctness === "cannot_judge" || j.legibility === "illegible";
}

/** One key item on the review page: what was expected, what the student wrote, the AI's judgment, and overrides. */
export function ItemCard({ submissionId, entry, onShowPage }: ItemCardProps) {
  const { item, result, score } = entry;
  const judgment = result?.judgment ?? null;

  return (
    <article
      aria-labelledby={`item-${item.id}-title`}
      className={cx(
        "flex flex-col gap-3 rounded-xl border bg-surface p-4 shadow-sm",
        needsAttention(judgment) ? "border-warning-200 ring-1 ring-warning-200" : "border-line",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`item-${item.id}-title`} className="flex flex-wrap items-baseline gap-x-2 font-semibold">
          {item.label}
          <span className="text-sm font-normal text-muted">{ANSWER_TYPE_LABEL[item.answerType]}</span>
        </h3>
        <p className="flex items-center gap-2">
          <span className="font-semibold tabular-nums">
            {formatPoints(score.earnedCenti)} / {formatPoints(score.maxCenti)} pts
          </span>
          {score.overridden && <Badge tone="info">Your points</Badge>}
        </p>
      </header>

      {item.prompt && <p className="whitespace-pre-wrap text-sm text-muted">{item.prompt}</p>}

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">Expected</dt>
          <dd className="whitespace-pre-wrap">{item.expectedAnswer || "—"}</dd>
          {item.acceptableAnswers.length > 0 && (
            <dd className="whitespace-pre-wrap text-muted">Also accepted: {item.acceptableAnswers.join(" · ")}</dd>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">Student wrote</dt>
          <dd className="whitespace-pre-wrap rounded-md bg-subtle px-2 py-1 font-mono text-[13px]">
            {judgment ? judgment.studentAnswer || "(blank)" : "No AI judgment"}
          </dd>
          {judgment && judgment.pages.length > 0 && (
            <dd className="flex flex-wrap gap-1">
              {judgment.pages.map((page) => (
                <Button key={page} variant="ghost" size="sm" onClick={() => onShowPage(page)} aria-label={`Show page ${page} of the paper`}>
                  p.{page}
                </Button>
              ))}
            </dd>
          )}
        </div>
      </dl>

      {judgment && <JudgmentChips judgment={judgment} />}

      {judgment?.teacherNote && (
        <p className="whitespace-pre-wrap rounded-md border border-info-200 bg-info-50 px-3 py-2 text-sm text-info-800">
          <span className="font-semibold">Note for you: </span>
          {judgment.teacherNote}
        </p>
      )}

      <OverrideForm submissionId={submissionId} entry={entry} />
    </article>
  );
}

function JudgmentChips({ judgment: j }: { judgment: ItemJudgment }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="The AI's judgment">
      <li>
        <Badge tone={CORRECTNESS_TONE[j.correctness]}>{CORRECTNESS_LABEL[j.correctness]}</Badge>
      </li>
      <li>
        <Badge tone={ATTEMPT_TONE[j.attempt]}>Attempt: {ATTEMPT_LABEL[j.attempt]}</Badge>
      </li>
      <li>
        <Badge tone={LEGIBILITY[j.legibility].tone}>{LEGIBILITY[j.legibility].label}</Badge>
      </li>
      <li>
        <Badge tone={CONFIDENCE[j.confidence].tone}>{CONFIDENCE[j.confidence].label}</Badge>
      </li>
      {j.reviewReason !== "none" && (
        <li>
          <Badge tone="warning">Check: {REVIEW_REASON_LABEL[j.reviewReason]}</Badge>
        </li>
      )}
    </ul>
  );
}

/** The key under which an item's override form reports unsaved edits to the review page. */
export function itemFormKey(itemId: string): string {
  return `item:${itemId}`;
}

/** Text left as the AI wrote it is not an override, so a later regrade can still replace it. */
function overrideText(text: string, aiText: string): string | null {
  const trimmed = text.trim();
  return trimmed === aiText.trim() ? null : trimmed;
}

/**
 * Points override and the two notes the student reads ("what you did" and feedback). All are saved
 * together (the action stores them all); "Clear" and the "Use the AI's …" buttons save at once,
 * leaving the other fields as stored.
 */
function OverrideForm({ submissionId, entry }: { submissionId: string; entry: ReviewItemView }) {
  const { item, result, score } = entry;
  const aiFeedback = result?.judgment?.feedback ?? "";
  const aiNote = result?.judgment?.whatStudentDid ?? "";
  const storedPoints = pointsInputText(result?.overrideCenti ?? null);
  const storedFeedback = result?.overrideFeedback ?? aiFeedback;
  const storedNote = result?.overrideWhatStudentDid ?? aiNote;
  const hasPointsOverride = result !== null && result.overrideCenti !== null;
  const hasFeedbackOverride = result !== null && result.overrideFeedback !== null;
  const hasNoteOverride = result !== null && result.overrideWhatStudentDid !== null;
  const [points, setPoints, expectSavedPoints] = useSyncedState(storedPoints);
  const [feedback, setFeedback, expectSavedFeedback] = useSyncedState(storedFeedback);
  const [note, setNote, expectSavedNote] = useSyncedState(storedNote);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const runner = useActionRunner();
  const dirty = points !== storedPoints || feedback !== storedFeedback || note !== storedNote;
  useReportUnsaved(itemFormKey(item.id), `Question ${item.label}`, dirty);
  const ids = { points: `override-${item.id}-points`, feedback: `override-${item.id}-feedback`, note: `override-${item.id}-note` };

  function save(pointsText: string, feedbackText: string, noteText: string) {
    const parsed = parsePointsOverride(pointsText, score.maxCenti);
    if (!parsed.ok) {
      setPointsError(parsed.error);
      return;
    }
    setPointsError(null);
    // Each field that changes takes the stored version once saved; the others keep any unsaved edit.
    const expect = (on: boolean) => {
      if (pointsText !== storedPoints) expectSavedPoints(on);
      if (feedbackText !== storedFeedback) expectSavedFeedback(on);
      if (noteText !== storedNote) expectSavedNote(on);
    };
    expect(true);
    runner.run(
      () => saveItemOverrideAction(submissionId, item.id, {
        pointsCenti: parsed.centi,
        feedback: overrideText(feedbackText, aiFeedback),
        whatStudentDid: overrideText(noteText, aiNote),
      }),
      undefined,
      () => expect(false),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save(points, feedback, note);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-line pt-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor={ids.note} className="text-sm font-medium">
            What you did (the student sees this)
          </label>
          {hasNoteOverride && (
            <Button
              variant="ghost"
              size="sm"
              disabled={runner.pending}
              onClick={() => {
                setNote(aiNote);
                save(storedPoints, storedFeedback, aiNote);
              }}
            >
              Use the AI&apos;s note
            </Button>
          )}
        </div>
        <Textarea
          id={ids.note}
          rows={2}
          maxLength={1000}
          aria-describedby={`${ids.note}-hint`}
          className="sm:text-sm"
          readOnly={runner.pending}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p id={`${ids.note}-hint`} className="text-xs text-muted">
          Correct it if the AI misread the work; leave it empty to hide it.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor={ids.feedback} className="text-sm font-medium">
            Feedback (the student sees this)
          </label>
          {hasFeedbackOverride && (
            <Button
              variant="ghost"
              size="sm"
              disabled={runner.pending}
              onClick={() => {
                setFeedback(aiFeedback);
                save(storedPoints, aiFeedback, storedNote);
              }}
            >
              Use the AI&apos;s feedback
            </Button>
          )}
        </div>
        <Textarea
          id={ids.feedback}
          rows={2}
          maxLength={2000}
          className="sm:text-sm"
          readOnly={runner.pending}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.points} className="text-sm font-medium">
            Points override
          </label>
          <div className="flex items-center gap-2">
            <div className="w-24">
              <Input
                id={ids.points}
                inputMode="decimal"
                placeholder={score.computedCenti === null ? "—" : formatPoints(score.computedCenti)}
                aria-invalid={pointsError ? true : undefined}
                aria-describedby={`${ids.points}-hint`}
                className="sm:min-h-9 sm:text-sm"
                readOnly={runner.pending}
                value={points}
                onChange={(e) => setPoints(e.target.value)}
              />
            </div>
            <span className="text-sm text-muted">/ {formatPoints(score.maxCenti)}</span>
          </div>
        </div>
        {hasPointsOverride && (
          <Button
            variant="secondary"
            size="sm"
            disabled={runner.pending}
            onClick={() => {
              setPoints("");
              save("", storedFeedback, storedNote);
            }}
          >
            Clear
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!dirty || runner.pending}>
          {runner.pending && <Spinner className="size-4" />}
          Save
        </Button>
      </div>
      <p id={`${ids.points}-hint`} className="text-xs text-muted">
        Computed from the AI&apos;s judgment: {score.computedCenti === null ? "no judgment" : `${formatPoints(score.computedCenti)} pts`}.
        Leave the override empty to use it.
      </p>
      {(pointsError || runner.error) && <Alert tone="danger">{pointsError ?? runner.error}</Alert>}
    </form>
  );
}
