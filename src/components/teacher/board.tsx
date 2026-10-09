import Link from "next/link";
import { FlagChips } from "@/components/flag-chips";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { LocalTime } from "@/components/ui/local-time";
import { formatPercent, formatPoints, OUTCOME_LABEL, STATUS_LABEL } from "@/lib/format";
import type { BoardRow, BoardView } from "@/lib/types";
import { reviewHref } from "./board-helpers";
import { OUTCOME_TONE } from "./question-stats";
import { plural } from "./text";

export interface BoardProps {
  assignmentId: string;
  groups: BoardView["groups"];
}

/** Papers grouped by section, then by surname: a table from `md` up, cards on phones. */
export function Board({ assignmentId, groups }: BoardProps) {
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <BoardGroup key={group.key} assignmentId={assignmentId} group={group} />
      ))}
    </div>
  );
}

function BoardGroup({ assignmentId, group }: { assignmentId: string; group: BoardView["groups"][number] }) {
  const { label, rows } = group;
  const headingId = `board-group-${group.key}`;
  const toReview = rows.filter((row) => row.status === "needs_review").length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
        {label}
        <span className="text-sm font-normal text-muted">
          {plural(rows.length, "paper")}
          {toReview > 0 && <span className="font-medium text-warning-800"> · {toReview} to review</span>}
        </span>
      </h2>

      <div className="hidden overflow-hidden rounded-xl border border-line bg-surface shadow-sm md:block">
        {/* Fixed columns, the same in every section's table, so Status, Score and the rest line up down the page. */}
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[18%]" />
            <col className="w-[14%]" />
            <col />
            <col className="w-[19%]" />
          </colgroup>
          <thead className="border-b border-line bg-subtle text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2">Student</th>
              <th scope="col" className="px-4 py-2">Status</th>
              <th scope="col" className="px-4 py-2 text-right">Score</th>
              <th scope="col" className="px-4 py-2">Flags</th>
              <th scope="col" className="px-4 py-2">Submitted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.submissionId} className={cx("align-top", rowBackground(row))}>
                <td className="break-words px-4 py-3">
                  <StudentCell assignmentId={assignmentId} row={row} />
                </td>
                <td className="px-4 py-3">
                  <StatusCell row={row} />
                </td>
                <td className="px-4 py-3 text-right">
                  <ScoreCell row={row} />
                </td>
                <td className="px-4 py-3">
                  <FlagChips flags={row.flags} />
                </td>
                <td className="px-4 py-3 text-muted">
                  <SubmittedCell row={row} stacked />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li
            key={row.submissionId}
            className={cx("relative flex flex-col gap-2 rounded-xl border border-line p-3 shadow-sm", rowBackground(row))}
          >
            <div className="flex items-start justify-between gap-3">
              <StudentCell assignmentId={assignmentId} row={row} stretched />
              <div className="shrink-0 text-right">
                <ScoreCell row={row} />
              </div>
            </div>
            <StatusCell row={row} />
            <FlagChips flags={row.flags} />
            <p className="text-xs text-muted">
              <SubmittedCell row={row} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Papers waiting for the teacher stand out from the rest. */
function rowBackground(row: BoardRow): string {
  if (row.status === "needs_review") return "bg-warning-50";
  if (row.status === "failed") return "bg-danger-50";
  return "bg-surface";
}

/**
 * The name links to the review page. On phone cards the link is stretched over the whole card, so the
 * earlier-attempts disclosure is lifted above it to stay clickable.
 */
function StudentCell({ assignmentId, row, stretched = false }: { assignmentId: string; row: BoardRow; stretched?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Link
        href={reviewHref(assignmentId, row.submissionId)}
        className={cx("font-semibold text-ink", stretched && "after:absolute after:inset-0 after:rounded-xl")}
      >
        {row.displayName}
      </Link>
      {row.missed && <MissedAnswer missed={row.missed} />}
      {row.source === "teacher" && (
        <span>
          <Badge tone="neutral" title="You uploaded this paper">
            Scanned copy
          </Badge>
        </span>
      )}
      {row.earlier.length > 0 && (
        <details className="relative z-10 text-xs text-muted">
          {/* 44 px tap targets on phone cards, where a near miss would open the newest paper instead. */}
          <summary className="cursor-pointer py-3.5 md:py-1">{plural(row.earlier.length, "earlier attempt")}</summary>
          <ul className="flex flex-col pl-4 md:mt-1 md:gap-1">
            {row.earlier.map((attempt) => (
              <li key={attempt.submissionId}>
                <Link
                  href={reviewHref(assignmentId, attempt.submissionId)}
                  className="inline-flex min-h-11 items-center md:inline md:min-h-0"
                >
                  <LocalTime ms={attempt.createdAt} />
                </Link>{" "}
                · {STATUS_LABEL[attempt.status]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** On the "missed" filter: how the paper did on the question and what the student wrote (as the AI read it). */
function MissedAnswer({ missed }: { missed: NonNullable<BoardRow["missed"]> }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <Badge tone={OUTCOME_TONE[missed.outcome]}>{OUTCOME_LABEL[missed.outcome]}</Badge>
      {missed.answer.trim() !== "" ? (
        <span className="line-clamp-3 min-w-0 break-words text-ink">
          <span className="sr-only">Answer: </span>“{missed.answer}”
        </span>
      ) : (
        <span className="text-muted">Nothing written</span>
      )}
    </p>
  );
}

function StatusCell({ row }: { row: BoardRow }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-1">
        <StatusBadge status={row.status} />
        {row.stale && (
          <Badge tone="warning" title="Graded with an earlier version of the answer key">
            Old key
          </Badge>
        )}
      </div>
      {row.statusNote && <p className="whitespace-pre-wrap text-xs text-muted">{row.statusNote}</p>}
    </div>
  );
}

function ScoreCell({ row }: { row: BoardRow }) {
  if (row.scoreEarnedCenti === null || row.scoreMaxCenti === null) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col items-end">
      <span className="whitespace-nowrap font-semibold tabular-nums">
        {formatPoints(row.scoreEarnedCenti)} / {formatPoints(row.scoreMaxCenti)}
      </span>
      <span className="text-xs tabular-nums text-muted">{formatPercent(row.percentTenths)}</span>
    </span>
  );
}

/** When the paper came in and its length; `stacked` (the table) puts the page count on a line of its own. */
function SubmittedCell({ row, stacked = false }: { row: BoardRow; stacked?: boolean }) {
  if (stacked) {
    return (
      <>
        <LocalTime ms={row.createdAt} className="block" />
        <span className="block text-xs">{plural(row.pageCount, "page")}</span>
      </>
    );
  }
  return (
    <>
      <LocalTime ms={row.createdAt} /> · {plural(row.pageCount, "page")}
    </>
  );
}
