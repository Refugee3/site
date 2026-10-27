import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { ArrowRightIcon, BookIcon, QuizIcon } from "@/components/ui/icons";
import { LocalTime } from "@/components/ui/local-time";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Ring } from "@/components/ui/ring";
import { TONE_CLASSES } from "@/components/ui/tone";
import { formatPercent, KIND_LABEL } from "@/lib/format";
import type { DashboardView } from "@/lib/types";
import { nextStep } from "./next-step";

type DashboardAssignment = DashboardView["assignments"][number];

export interface AssignmentCardProps {
  assignment: DashboardAssignment;
}

/**
 * One assignment on the dashboard: how much is graded (a ring), the class average, paper counts and, in one line, the
 * next thing it needs from the teacher.
 */
export function AssignmentCard({ assignment: a }: AssignmentCardProps) {
  const step = nextStep(a);
  const inProgress = a.counts.queued + a.counts.grading;
  const done = a.counts.graded + a.counts.needs_review;
  const quiz = a.kind === "quiz";
  const Icon = quiz ? QuizIcon : BookIcon;

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(20_23_51/0.04),0_8px_24px_-12px_rgb(20_23_51/0.12)] transition hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgb(20_23_51/0.06),0_16px_32px_-12px_rgb(20_23_51/0.2)] motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <div aria-hidden="true" className={cx("h-1.5", quiz ? "bg-gradient-to-r from-brand-500 to-brand-700" : "bg-gradient-to-r from-ember-400 to-ember-600")} />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <span className={cx("grid size-10 shrink-0 place-items-center rounded-xl", quiz ? "bg-brand-50 text-brand-700" : "bg-ember-50 text-ember-700")}>
            <Icon />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="min-w-0 text-lg font-semibold leading-snug">
              <Link href={`/teacher/assignments/${a.id}`} className="break-words text-ink no-underline hover:text-brand-700 hover:underline">
                {a.title}
              </Link>
            </h2>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <Badge tone={quiz ? "info" : "neutral"}>{KIND_LABEL[a.kind]}</Badge>
              <span>
                Created <LocalTime ms={a.createdAt} />
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Ring
            value={a.counts.total > 0 ? done / a.counts.total : 0}
            label={`${done} of ${a.counts.total} papers graded`}
            tone={a.counts.total > 0 && done === a.counts.total ? "success" : "brand"}
          >
            {a.counts.total > 0 ? `${done}/${a.counts.total}` : "0"}
          </Ring>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Class average</span>
            <span className="text-2xl font-bold tabular-nums text-ink">
              {a.averageTenths === null || a.averageTenths === undefined ? "—" : formatPercent(a.averageTenths)}
            </span>
          </div>
          <dl className="grid shrink-0 grid-cols-1 gap-1 text-right text-xs">
            <Count label="To check" value={a.counts.needs_review} highlight={a.counts.needs_review > 0} />
            <Count label="Grading" value={inProgress} />
          </dl>
        </div>

        {a.progress && (
          <div className="flex items-center gap-3">
            <ProgressBar
              size="sm"
              value={a.progress.total > 0 ? a.progress.done / a.progress.total : 0}
              label={`Grading ${a.title}`}
              valueText={`${a.progress.done} of ${a.progress.total} graded`}
            />
            <p className="shrink-0 text-sm text-muted tabular-nums">
              {a.progress.done}/{a.progress.total} graded
            </p>
          </div>
        )}

        <Link
          href={step.href}
          className={cx(
            "mt-auto flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm font-semibold no-underline transition hover:brightness-[0.97]",
            TONE_CLASSES[step.tone],
          )}
        >
          <span>{step.text}</span>
          <ArrowRightIcon className="size-4" />
        </Link>
      </div>
    </article>
  );
}

function Count({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("min-w-6 rounded-md px-1.5 py-0.5 text-center font-semibold tabular-nums", highlight ? "bg-warning-50 text-warning-800" : "bg-subtle text-ink")}>
        {value}
      </dd>
    </div>
  );
}
