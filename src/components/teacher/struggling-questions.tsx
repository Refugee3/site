import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { KIND_LABEL } from "@/lib/format";
import { MISS_HIGHLIGHT_MIN_PAPERS } from "@/lib/grading/item-stats";
import type { StrugglingQuestion } from "@/lib/types";
import { MissMeter } from "./question-stats";
import { missedHref, questionName, shortPrompt, strugglingLine } from "./question-text";

/** How many rows the dashboard shows before "Show all". */
export const STRUGGLING_TOP = 10;

export interface StrugglingQuestionsProps {
  questions: StrugglingQuestion[];
  /** `?struggling=all`: every row instead of the top STRUGGLING_TOP. */
  showAll: boolean;
  /** The dashboard URL with and without `?struggling=all` (other query parameters kept). */
  showAllHref: string;
  showTopHref: string;
}

/**
 * The dashboard's "Where students are struggling": every question most of a class missed, across all of the teacher's
 * homework and quizzes, most missed first, each linking to the papers that missed it.
 */
export function StrugglingQuestions({ questions, showAll, showAllHref, showTopHref }: StrugglingQuestionsProps) {
  const shown = showAll ? questions : questions.slice(0, STRUGGLING_TOP);
  const more = questions.length > STRUGGLING_TOP;
  return (
    <Card
      title={<span id="struggling">Where students are struggling</span>}
      actions={
        more ? (
          <Link href={showAll ? showTopHref : showAllHref} scroll={false} className="inline-flex min-h-11 items-center text-sm font-medium sm:min-h-0">
            {showAll ? `Show the top ${STRUGGLING_TOP}` : `Show all ${questions.length}`}
          </Link>
        ) : undefined
      }
    >
      {questions.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink">No question was missed by most of a class yet.</p>
          <p className="text-sm text-muted">
            A question shows up here when more than half of the students missed it, once at least {MISS_HIGHLIGHT_MIN_PAPERS} papers
            are graded.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Questions more than half of the class got wrong, across all your homework and quizzes — the topics to go over again.
            Partly right answers count by the credit they lost.
          </p>
          <ol className="flex flex-col divide-y divide-line" aria-labelledby="struggling">
            {shown.map((q) => (
              <li key={`${q.assignmentId}:${q.itemId}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span className="min-w-0 break-words">{q.assignmentTitle}</span>
                  <Badge tone={q.kind === "quiz" ? "info" : "neutral"}>{KIND_LABEL[q.kind]}</Badge>
                </div>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                  <p className="min-w-0 font-semibold text-ink">
                    {questionName(q.label)}
                    {q.prompt.trim() !== "" && <span className="font-normal text-muted"> — {shortPrompt(q.prompt, 120)}</span>}
                  </p>
                  <p className="shrink-0 text-sm font-semibold tabular-nums text-danger-800">{strugglingLine(q)}</p>
                </div>
                <MissMeter tenths={q.missedTenths} />
                <Link
                  href={missedHref(q.assignmentId, q.itemId)}
                  className="inline-flex min-h-11 items-center self-start text-sm font-medium sm:min-h-0"
                >
                  See who missed it
                  <span className="sr-only">: {questionName(q.label)} in {q.assignmentTitle}</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}
