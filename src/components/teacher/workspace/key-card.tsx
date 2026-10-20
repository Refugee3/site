"use client";

import Link from "next/link";
import { useState } from "react";
import { answerKeyQuestionsAction, approveKeyAction } from "@/actions/key";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatPoints } from "@/lib/format";
import type { LiveKey, LiveKeyQuestion } from "@/lib/live/snapshot";
import type { KeyQuestionKind } from "@/lib/types";
import { KeyUpload } from "../key-upload";
import { EstimatedProgress } from "../progress-widgets";
import { RetryExtractionButton } from "../retry-extraction-button";
import { plural } from "../text";
import { useActionRunner } from "../use-action-runner";

export interface KeyCardProps {
  assignmentId: string;
  keyState: LiveKey;
  questions: LiveKeyQuestion[];
  serverNow: number;
}

const QUESTION_KIND_LABEL: Record<KeyQuestionKind, string> = {
  missing_answer: "Missing answer",
  points: "Points",
  partial_credit: "Partial credit",
  accept_equivalents: "Equivalent answers",
  ambiguous_item: "Unclear question",
  other: "Question",
};

/** Step 1 of the workspace: add the key, watch it being read, answer the AI's questions, approve it. */
export function KeyCardBody({ assignmentId, keyState: key, questions, serverNow }: KeyCardProps) {
  const keyHref = `/teacher/assignments/${assignmentId}/key`;
  const uploadUrl = `/api/teacher/assignments/${assignmentId}/key`;

  switch (key.status) {
    case "empty":
      return (
        <>
          <KeyUpload uploadUrl={uploadUrl} disabled={false} zoneTitle="Drop the answer key here" />
          <p className="text-sm text-muted">
            The AI lists every question with its answer and asks you about anything unclear. No file?{" "}
            <Link href={`${keyHref}?manual=1`}>Type the key in yourself</Link>.
          </p>
        </>
      );
    case "processing":
      return (
        <div className="flex items-start gap-3">
          <Spinner className="mt-0.5 size-6 shrink-0 text-brand-600" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {key.extraction ? (
              <EstimatedProgress
                label="Reading your answer key…"
                barLabel="Reading the answer key"
                startedAt={key.extraction.startedAt}
                typicalMs={key.extraction.typicalMs}
                serverNow={serverNow}
              />
            ) : (
              <p className="font-semibold">Reading your answer key…</p>
            )}
            <p className="text-sm text-muted">
              {key.filename && <span className="break-words">{key.filename}{key.pageCount !== null && ` · ${plural(key.pageCount, "page")}`}. </span>}
              The AI is listing every question with its answer. If anything needs your call, its questions appear right here.
            </p>
          </div>
        </div>
      );
    case "failed":
      return (
        <>
          <Alert tone="danger" title="The answer key couldn't be read">
            <p className="whitespace-pre-wrap">{key.errorMessage ?? "The AI could not turn this file into a list of questions."}</p>
          </Alert>
          <div className="flex flex-wrap items-start gap-3">
            {key.filename !== null && !key.locked && <RetryExtractionButton assignmentId={assignmentId} label="Try again" />}
            <KeyUpload uploadUrl={uploadUrl} disabled={key.locked} label="Upload a different file" variant="secondary" />
          </div>
          <p className="text-sm text-muted">
            Or <Link href={`${keyHref}?manual=1`}>type the key in yourself</Link>.
          </p>
        </>
      );
    case "ready": {
      if (key.approved) return <ApprovedKey keyState={key} keyHref={keyHref} questions={questions} />;
      const pending = questions.filter((q) => q.status === "pending");
      if (pending.length > 0) return <QuestionsPanel assignmentId={assignmentId} pending={pending} keyState={key} keyHref={keyHref} />;
      return <ApprovePanel assignmentId={assignmentId} keyState={key} keyHref={keyHref} questions={questions} />;
    }
  }
}

function KeySummary({ keyState: key, keyHref }: { keyState: LiveKey; keyHref: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
      <p>
        <span className="font-semibold">{plural(key.itemCount, "question")}</span>
        <span className="text-muted"> · </span>
        <span className="font-semibold">{formatPoints(key.totalPointsCenti)} points</span>
        {key.filename && (
          <span className="text-sm text-muted">
            {" "}
            · from <span className="break-all">{key.filename}</span>
            {key.pageCount !== null && ` (${plural(key.pageCount, "page")})`}
          </span>
        )}
      </p>
      <Link href={keyHref} className="inline-flex min-h-11 items-center text-sm font-medium sm:min-h-0">
        Review/edit the full key
      </Link>
    </div>
  );
}

function answeredLine(questions: LiveKeyQuestion[]): string | null {
  const answered = questions.filter((q) => q.status === "answered").length;
  if (answered === 0) return null;
  return answered === 1 ? "Your answer to the AI's question is in the key." : `Your answers to the AI's ${answered} questions are in the key.`;
}

function ApprovedKey({ keyState: key, keyHref, questions }: { keyState: LiveKey; keyHref: string; questions: LiveKeyQuestion[] }) {
  const answered = answeredLine(questions);
  return (
    <>
      <p className="flex items-center gap-2 font-medium text-success-800">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        Approved. Papers are graded against this key.
      </p>
      <KeySummary keyState={key} keyHref={keyHref} />
      {answered && <p className="text-sm text-muted">{answered}</p>}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The AI's questions

interface Draft {
  text: string;
  skipped: boolean;
  /** The teacher chose "Other…" on a question with choices: the text field shows. */
  other: boolean;
}

function initialDraft(q: LiveKeyQuestion): Draft {
  const text = q.suggestedAnswer ?? "";
  return { text, skipped: false, other: q.choices.length > 0 && text !== "" && !q.choices.includes(text) };
}

function QuestionsPanel(props: { assignmentId: string; pending: LiveKeyQuestion[]; keyState: LiveKey; keyHref: string }) {
  const { assignmentId, pending, keyState: key, keyHref } = props;
  const runner = useActionRunner();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftOf = (q: LiveKeyQuestion) => drafts[q.id] ?? initialDraft(q);
  const set = (q: LiveKeyQuestion, change: Partial<Draft>) => setDrafts((current) => ({ ...current, [q.id]: { ...draftOf(q), ...change } }));
  const answering = pending.filter((q) => !draftOf(q).skipped && draftOf(q).text.trim() !== "").length;

  function save() {
    const answers = pending.map((q) => {
      const draft = draftOf(q);
      return { id: q.id, answer: draft.skipped ? null : draft.text };
    });
    runner.run(() => answerKeyQuestionsAction(assignmentId, answers));
  }

  return (
    <>
      <KeySummary keyState={key} keyHref={keyHref} />
      <div className="flex flex-col gap-4 rounded-xl border border-warning-200 bg-warning-50/60 p-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-ink">A few questions before grading</h3>
          <p className="text-sm text-muted">
            The AI read your key and needs your call on {pending.length === 1 ? "this" : `these ${pending.length}`}. Your answers go
            straight into the key; skip any you don&apos;t care about.
          </p>
        </div>
        <fieldset disabled={runner.pending} className="min-w-0">
          <legend className="sr-only">The AI&apos;s questions about the key</legend>
          <ol className="flex flex-col gap-3">
            {pending.map((q, index) => (
              <QuestionRow key={q.id} q={q} index={index} draft={draftOf(q)} onChange={(change) => set(q, change)} />
            ))}
          </ol>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={runner.pending}>
            {runner.pending && <Spinner className="size-4" />}
            Save answers and continue
          </Button>
          <p className="text-sm text-muted">
            {answering === 0 ? "Nothing answered: the key stays as the AI read it." : `${plural(answering, "answer")} to save.`}
          </p>
        </div>
        {runner.error && <Alert tone="danger">{runner.error}</Alert>}
      </div>
    </>
  );
}

function QuestionRow({ q, index, draft, onChange }: { q: LiveKeyQuestion; index: number; draft: Draft; onChange: (change: Partial<Draft>) => void }) {
  const textId = `key-question-${q.id}`;
  const inputId = `${textId}-answer`;
  const showText = q.choices.length === 0 || draft.other;
  const long = q.kind === "missing_answer" || q.kind === "partial_credit" || q.kind === "ambiguous_item";
  return (
    <li className={cx("flex flex-col gap-2 rounded-lg border bg-surface p-3 sm:p-4", draft.skipped ? "border-line" : "border-warning-200")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold tabular-nums text-muted">{index + 1}.</span>
        {q.itemLabel && <Badge tone="info">Question {q.itemLabel}</Badge>}
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{QUESTION_KIND_LABEL[q.kind]}</span>
      </div>
      <p id={textId} className={cx("font-medium", draft.skipped ? "text-muted line-through decoration-1" : "text-ink")}>
        {q.question}
      </p>
      {draft.skipped ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>Skipped: the key stays as the AI read it.</span>
          <Button variant="ghost" size="sm" onClick={() => onChange({ skipped: false })}>
            Undo<span className="sr-only">: answer question {index + 1}</span>
          </Button>
        </div>
      ) : (
        <>
          {q.choices.length > 0 && (
            <div role="radiogroup" aria-labelledby={textId} className="flex flex-wrap gap-2">
              {[...q.choices, "Other…"].map((choice) => {
                const isOther = choice === "Other…";
                const checked = isOther ? draft.other : !draft.other && draft.text === choice;
                return (
                  <label
                    key={choice}
                    className={cx(
                      "flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-medium sm:min-h-9",
                      "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-600",
                      checked ? "border-brand-600 bg-brand-600 text-white" : "border-line-strong bg-surface text-ink hover:bg-subtle",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${textId}-choice`}
                      value={choice}
                      checked={checked}
                      onChange={() => onChange(isOther ? { other: true, text: "" } : { other: false, text: choice })}
                      className="sr-only"
                    />
                    {choice}
                  </label>
                );
              })}
            </div>
          )}
          {showText && (
            <div className="flex flex-col gap-1">
              <label htmlFor={inputId} className="sr-only">Your answer</label>
              {long ? (
                <Textarea id={inputId} rows={2} maxLength={2000} aria-describedby={textId} value={draft.text}
                  placeholder="Your answer" onChange={(e) => onChange({ text: e.target.value })} />
              ) : (
                <Input id={inputId} maxLength={2000} aria-describedby={textId} value={draft.text}
                  placeholder={q.kind === "points" ? "e.g. 2 each, or Q1-5: 1, Q6: 3" : "Your answer"} onChange={(e) => onChange({ text: e.target.value })} />
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted">
              {q.suggestedAnswer
                ? draft.text === q.suggestedAnswer ? "The AI's suggestion, filled in for you." : <>The AI suggested: <span className="break-words">{q.suggestedAnswer}</span></>
                : null}
            </p>
            <Button variant="ghost" size="sm" onClick={() => onChange({ skipped: true })}>
              Skip<span className="sr-only"> question {index + 1}</span>
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Approving

function ApprovePanel(props: { assignmentId: string; keyState: LiveKey; keyHref: string; questions: LiveKeyQuestion[] }) {
  const { assignmentId, keyState: key, keyHref, questions } = props;
  const runner = useActionRunner();
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = key.aiProposedCount > 0;
  const answered = answeredLine(questions);

  function approve() {
    runner.run(() => approveKeyAction(assignmentId, { acknowledgeAiProposed: needsAck && acknowledged, seenUpdatedAt: key.updatedAt }));
  }

  return (
    <>
      <KeySummary keyState={key} keyHref={keyHref} />
      {answered && <p className="text-sm text-muted">{answered}</p>}
      {key.uncertainCount > 0 && (
        <p className="text-sm text-warning-800">
          The AI was unsure about {plural(key.uncertainCount, "question")}; {key.uncertainCount === 1 ? "it is" : "they are"} marked in the{" "}
          <Link href={keyHref}>full key</Link>.
        </p>
      )}
      {key.aiNotes.trim() !== "" && (
        <details className="rounded-lg border border-line bg-subtle px-3 py-2 text-sm">
          <summary className="min-h-11 cursor-pointer content-center font-medium sm:min-h-0">Notes from the AI</summary>
          <p className="mt-2 whitespace-pre-wrap text-muted">{key.aiNotes}</p>
        </details>
      )}
      <div className="flex flex-col gap-3 rounded-xl border border-brand-100 bg-brand-50 p-4">
        <p className="text-sm text-ink">Papers are graded only against an approved key. Check it, then approve it to start on your students&apos; work.</p>
        {needsAck && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <Input type="checkbox" checked={acknowledged} disabled={runner.pending} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span className="text-sm font-medium">
              I checked the {key.aiProposedCount === 1 ? "answer" : `${key.aiProposedCount} answers`} the AI proposed (
              <Link href={keyHref}>see the key</Link>)
            </span>
          </label>
        )}
        <Button size="lg" className="self-start" onClick={approve} disabled={runner.pending || (needsAck && !acknowledged)}>
          {runner.pending && <Spinner className="size-5" />}
          Approve key
        </Button>
        {runner.error && <Alert tone="danger">{runner.error} <Link href={keyHref}>Open the full key</Link></Alert>}
      </div>
    </>
  );
}
