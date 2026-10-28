import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { UsersIcon } from "@/components/ui/icons";
import type { AnswerMatch, AnswerMatchSummary, SharedWrongAnswer } from "@/lib/grading/answer-match";
import { MATCH_MIN_PAPERS } from "@/lib/grading/answer-match";
import { reviewHref } from "./board-helpers";
import { plural } from "./text";

/** Matches listed before the rest fold under "Show N more". */
const SHOWN = 8;

/**
 * A quiz's "Matching answers": pairs of students who gave the same wrong answers that few others chose, strongest first,
 * each linking to both papers. Quizzes only (the page doesn't render it for homework).
 */
export function MatchingAnswersCard({ assignmentId, summary }: { assignmentId: string; summary: AnswerMatchSummary }) {
  const { matches } = summary;
  return (
    <Card
      icon={<UsersIcon />}
      accent="gold"
      title={<span id="matching-answers">Matching answers</span>}
      actions={matches.length > 0 ? <Badge tone="warning">{plural(matches.length, "pair")} to look at</Badge> : undefined}
    >
      {!summary.enough ? (
        <p className="text-sm text-muted">
          Once {MATCH_MIN_PAPERS} or more papers are graded, students who picked the same unusual wrong answers show up here.
        </p>
      ) : matches.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink">No two students share unusual wrong answers.</p>
          <p className="text-sm text-muted">
            Checked {plural(summary.papers, "paper")}. Getting the same questions right doesn&apos;t count; only the same wrong answers
            that few others chose do.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            These students gave the same wrong answers, ones few others in the class chose. It can be a coincidence or studying
            together, so look at the papers before drawing conclusions.
          </p>
          <MatchList assignmentId={assignmentId} matches={matches.slice(0, SHOWN)} />
          {matches.length > SHOWN && (
            <details className="flex flex-col gap-3">
              <summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 sm:min-h-0">
                Show {plural(matches.length - SHOWN, "more pair")}
              </summary>
              <MatchList assignmentId={assignmentId} matches={matches.slice(SHOWN)} />
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function MatchList({ assignmentId, matches }: { assignmentId: string; matches: AnswerMatch[] }) {
  return (
    <ol className="flex flex-col divide-y divide-line" aria-labelledby="matching-answers">
      {matches.map((m) => (
        <li key={`${m.a.submissionId}:${m.b.submissionId}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StudentLink assignmentId={assignmentId} student={m.a} />
            <span className="text-muted">and</span>
            <StudentLink assignmentId={assignmentId} student={m.b} />
            <Badge tone={m.strength === "strong" ? "danger" : "warning"}>{m.strength === "strong" ? "Strong match" : "Possible match"}</Badge>
          </div>
          <p className="text-sm text-muted">
            {sectionsText(m)}Same answer on {m.same} of {m.compared} questions, including {plural(m.sharedWrong.length, "matching wrong answer")}.
          </p>
          <ul className="flex flex-wrap gap-2" aria-label="The same wrong answers">
            {m.sharedWrong.map((s) => (
              <li key={s.itemId} className="rounded-md border border-line bg-subtle px-2 py-1 text-sm text-ink">
                Q{s.label}: <span className="font-semibold">{s.answer}</span> <span className="text-muted">({othersText(s)})</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function StudentLink({ assignmentId, student }: { assignmentId: string; student: AnswerMatch["a"] }) {
  return (
    <Link href={reviewHref(assignmentId, student.submissionId)} className="font-semibold">
      {student.name ?? "No name"}
    </Link>
  );
}

function sectionsText(m: AnswerMatch): string {
  if (m.a.section === m.b.section) return m.a.section === "No section" ? "" : `${m.a.section}. `;
  return `${m.a.section} and ${m.b.section}. `;
}

function othersText(s: SharedWrongAnswer): string {
  if (s.others === 0) return "only these two";
  return `${plural(s.others, "other student")} too`;
}

/** The dashboard's alert: quizzes where students share unusual wrong answers, each linking to its list. */
export function QuizMatchAlerts({ alerts }: { alerts: Array<{ assignmentId: string; title: string; pairs: number; strong: number }> }) {
  if (alerts.length === 0) return null;
  return (
    <Card title="Matching answers on quizzes" icon={<UsersIcon />} accent="gold">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Students who gave the same unusual wrong answers on a quiz. Homework isn&apos;t checked, since students often work together.
        </p>
        <ul className="flex flex-col divide-y divide-line">
          {alerts.map((alert) => (
            <li key={alert.assignmentId} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
              <span className="min-w-0 break-words font-medium">{alert.title}</span>
              <span className="flex flex-wrap items-center gap-2">
                {alert.strong > 0 && <Badge tone="danger">{plural(alert.strong, "strong match", "strong matches")}</Badge>}
                <Link href={`/teacher/assignments/${alert.assignmentId}#matching-answers`} className="inline-flex min-h-11 items-center text-sm font-medium sm:min-h-0">
                  See {plural(alert.pairs, "pair")}
                  <span className="sr-only"> in {alert.title}</span>
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
