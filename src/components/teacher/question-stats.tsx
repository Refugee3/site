import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import type { Tone } from "@/components/ui/tone";
import { formatPercent, formatPoints, OUTCOME_LABEL } from "@/lib/format";
import {
  MISS_HIGHLIGHT_MIN_PAPERS, MISS_HIGHLIGHT_MIN_TENTHS, type ItemStats, type ItemStatsSummary, type ItemTally, type SectionItemStats,
} from "@/lib/grading/item-stats";
import type { ItemOutcome } from "@/lib/types";
import { missedHref, missedLine, questionName, shortPrompt } from "./question-text";

/** Red from this miss rate (tenths of a percent) up, amber below it. */
const RED_FROM_TENTHS = 600;

export const OUTCOME_TONE: Record<ItemOutcome, Tone> = {
  correct: "success",
  partly: "warning",
  wrong: "danger",
  blank: "neutral",
  unreadable: "info",
};

/** Bar segments in display order: right to wrong, then the answers with nothing to judge. */
const SEGMENTS: ReadonlyArray<{ outcome: ItemOutcome; className: string }> = [
  { outcome: "correct", className: "bg-success-600" },
  { outcome: "partly", className: "bg-warning-500" },
  { outcome: "wrong", className: "bg-danger-600" },
  { outcome: "blank", className: "bg-line-control" },
  { outcome: "unreadable", className: "bg-info-200" },
];

const THRESHOLD_TEXT = formatPercent(MISS_HIGHLIGHT_MIN_TENTHS);

// ---------------------------------------------------------------------------------------------
// The board's card

export interface MissedQuestionsCardProps {
  assignmentId: string;
  stats: ItemStatsSummary;
  /** The item the board is filtered to (`?missed=`), if any. */
  activeItemId: string | null;
}

/**
 * Top of the Submissions tab: the questions a large share of the class missed, most missed first, each linking to the
 * papers that missed it. A quiet line once enough papers are graded and none was; nothing before that.
 */
export function MissedQuestionsCard({ assignmentId, stats, activeItemId }: MissedQuestionsCardProps) {
  const questionsHref = `/teacher/assignments/${assignmentId}/questions`;
  if (stats.highlighted.length === 0) {
    if (stats.countedPapers < MISS_HIGHLIGHT_MIN_PAPERS) return null;
    return (
      <p className="text-sm text-muted">
        No question was missed by {THRESHOLD_TEXT} or more of the class. <Link href={questionsHref}>See every question</Link>
      </p>
    );
  }
  return (
    <Card title="Questions many students missed" actions={<Link href={questionsHref} className="text-sm">All questions</Link>}>
      <ul className="flex flex-col gap-5">
        {stats.highlighted.map((stat) => {
          const active = stat.item.id === activeItemId;
          return (
            <li key={stat.item.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="min-w-0 font-semibold text-ink">{missedLine(stat.item.label, stat)}</p>
                <Link
                  href={missedHref(assignmentId, stat.item.id)}
                  scroll={false}
                  aria-current={active ? "page" : undefined}
                  className={cx("inline-flex min-h-11 items-center text-sm font-medium sm:min-h-0", active && "text-ink no-underline")}
                >
                  {active ? "Showing papers" : "Show papers"}
                  <span className="sr-only"> that missed {questionName(stat.item.label)}</span>
                </Link>
              </div>
              <MissMeter tenths={stat.missedTenths ?? 0} />
              {stat.item.prompt.trim() !== "" && <p className="line-clamp-2 text-sm text-muted">{shortPrompt(stat.item.prompt)}</p>}
              {stat.sections.length > 0 && <SectionLine sections={stat.sections} />}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The accent bar: as long as the miss rate, red from 60%, amber below. Decorative; the text says the number. */
function MissMeter({ tenths }: { tenths: number }) {
  return (
    <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-subtle ring-1 ring-line ring-inset">
      <div
        className={cx("h-full rounded-full", tenths >= RED_FROM_TENTHS ? "bg-danger-600" : "bg-warning-500")}
        style={{ width: `${Math.min(100, Math.max(0, tenths / 10))}%` }}
      />
    </div>
  );
}

/** "By section: Period 1 70% missed (of 10) · Period 2 20% missed (of 8)". */
function SectionLine({ sections }: { sections: SectionItemStats[] }) {
  return (
    <p className="text-xs text-muted">
      <span className="font-medium">By section:</span>{" "}
      {sections.map((section, i) => (
        <span key={section.key}>
          {i > 0 && " · "}
          <span className="break-words">
            {section.label}{" "}
            {section.judged > 0 ? `${formatPercent(section.missedTenths)} missed (of ${section.judged})` : "none graded"}
          </span>
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// The Questions tab

/** The colors of the outcome bars, spelled out. */
export function OutcomeLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Bar colors">
      {SEGMENTS.map((segment) => (
        <li key={segment.outcome} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cx("inline-block size-3 rounded-sm", segment.className)} />
          {OUTCOME_LABEL[segment.outcome]}
        </li>
      ))}
    </ul>
  );
}

/** Every key item in key order: a table from `md` up, cards on phones. Highlighted questions are tinted and badged. */
export function QuestionStatsTable({ assignmentId, stats }: { assignmentId: string; stats: ItemStatsSummary }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-line bg-surface shadow-sm md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[22%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="border-b border-line bg-subtle text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2">Question</th>
              <th scope="col" className="px-4 py-2 text-right">Papers</th>
              <th scope="col" className="px-4 py-2 text-right">Correct</th>
              <th scope="col" className="px-4 py-2 text-right">Missed</th>
              <th scope="col" className="px-4 py-2">Answers</th>
              <th scope="col" className="px-4 py-2 text-right">Avg. points</th>
            </tr>
          </thead>
          {stats.items.map((stat) => (
            // One tbody per question, so a highlighted question's section breakdown stays with it.
            <tbody key={stat.item.id} className={cx("border-b border-line last:border-b-0", rowTint(stat))}>
              <tr className="align-top">
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <QuestionCell assignmentId={assignmentId} stat={stat} />
                </th>
                <td className="px-4 py-3 text-right tabular-nums">{stat.judged}</td>
                <td className="px-4 py-3 text-right tabular-nums">{rate(stat, stat.correctTenths)}</td>
                <td className={cx("px-4 py-3 text-right tabular-nums", stat.highlighted && "font-semibold text-danger-800")}>
                  {rate(stat, stat.missedTenths)}
                </td>
                <td className="px-4 py-3">
                  <OutcomeBar tally={stat} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <AveragePoints stat={stat} />
                </td>
              </tr>
              {stat.highlighted && stat.sections.length > 0 && (
                <tr>
                  <td colSpan={6} className="px-4 pb-3">
                    <SectionBreakdown sections={stat.sections} />
                  </td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {stats.items.map((stat) => (
          <li key={stat.item.id} className={cx("flex flex-col gap-3 rounded-xl border border-line p-3 shadow-sm", rowTint(stat))}>
            <QuestionCell assignmentId={assignmentId} stat={stat} />
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <Figure label="Correct" value={rate(stat, stat.correctTenths)} />
              <Figure label="Missed" value={rate(stat, stat.missedTenths)} strong={stat.highlighted} />
              <Figure label="Avg. points" value={<AveragePoints stat={stat} />} />
            </dl>
            <OutcomeBar tally={stat} />
            {stat.highlighted && stat.sections.length > 0 && <SectionBreakdown sections={stat.sections} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function rowTint(stat: ItemStats): string {
  if (!stat.highlighted) return "bg-surface";
  return (stat.missedTenths ?? 0) >= RED_FROM_TENTHS ? "bg-danger-50" : "bg-warning-50";
}

function rate(t: ItemTally, tenths: number | null): string {
  return t.judged > 0 ? formatPercent(tenths) : "—";
}

function QuestionCell({ assignmentId, stat }: { assignmentId: string; stat: ItemStats }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{questionName(stat.item.label)}</span>
        {stat.highlighted && <Badge tone={(stat.missedTenths ?? 0) >= RED_FROM_TENTHS ? "danger" : "warning"}>Many missed</Badge>}
      </div>
      {stat.item.prompt.trim() !== "" && <p className="line-clamp-2 break-words text-muted">{shortPrompt(stat.item.prompt)}</p>}
      {stat.missedPapers > 0 && (
        <Link href={missedHref(assignmentId, stat.item.id)} className="inline-flex min-h-11 items-center self-start text-sm md:min-h-0">
          {stat.missedPapers === 1 ? "Show the paper that missed it" : `Show the ${stat.missedPapers} papers that missed it`}
          <span className="sr-only"> ({questionName(stat.item.label)})</span>
        </Link>
      )}
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cx("tabular-nums", strong && "font-semibold text-danger-800")}>{value}</dd>
    </div>
  );
}

function AveragePoints({ stat }: { stat: ItemStats }) {
  if (stat.judged === 0) return <span className="text-muted">—</span>;
  return (
    <span className="whitespace-nowrap">
      {formatPoints(Math.round(stat.earnedCenti / stat.judged))} / {formatPoints(stat.item.pointsCenti)}
    </span>
  );
}

/** A stacked bar of the outcomes with the counts spelled out for screen readers and in its tooltip. */
export function OutcomeBar({ tally }: { tally: ItemTally }) {
  if (tally.judged === 0) return <span className="text-sm text-muted">Not graded yet</span>;
  const description = SEGMENTS.filter((segment) => tally[segment.outcome] > 0)
    .map((segment) => `${tally[segment.outcome]} ${OUTCOME_LABEL[segment.outcome].toLowerCase()}`)
    .join(", ");
  const label = `${description}, of ${tally.judged}`;
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={label} title={label} className="flex h-3 w-full overflow-hidden rounded-full bg-subtle ring-1 ring-line ring-inset">
        {SEGMENTS.map((segment) =>
          tally[segment.outcome] > 0 ? (
            <div key={segment.outcome} className={segment.className} style={{ width: `${(tally[segment.outcome] / tally.judged) * 100}%` }} />
          ) : null)}
      </div>
      <p aria-hidden="true" className="text-xs tabular-nums text-muted">
        {tally.correct} right · {tally.partly} partly · {tally.wrong} wrong · {tally.blank} blank
        {tally.unreadable > 0 && ` · ${tally.unreadable} unreadable`}
      </p>
    </div>
  );
}

/** A highlighted question's miss rate in each section. */
function SectionBreakdown({ sections }: { sections: SectionItemStats[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">By section</p>
      <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <li key={section.key} className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">{section.label}</span>
            <span className="shrink-0 tabular-nums text-muted">
              {section.judged > 0 ? (
                <>
                  <span className={cx("font-semibold", (section.missedTenths ?? 0) >= MISS_HIGHLIGHT_MIN_TENTHS ? "text-danger-800" : "text-ink")}>
                    {formatPercent(section.missedTenths)}
                  </span>{" "}
                  missed of {section.judged}
                </>
              ) : (
                "none graded"
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
