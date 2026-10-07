import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { LocalTime } from "@/components/ui/local-time";
import { TONE_CLASSES } from "@/components/ui/tone";
import { formatShareCode } from "@/lib/format";
import type { DashboardView } from "@/lib/types";
import { nextStep } from "./next-step";

type DashboardAssignment = DashboardView["assignments"][number];

export interface AssignmentCardProps {
  assignment: DashboardAssignment;
  /** Without student uploads there is no status or code to show: only teachers upload. */
  studentsCanUpload: boolean;
}

/** One assignment on the dashboard: status, paper counts and the next thing it needs from the teacher. */
export function AssignmentCard({ assignment: a, studentsCanUpload }: AssignmentCardProps) {
  const step = nextStep(a, { studentsCanUpload });
  const inProgress = a.counts.queued + a.counts.grading;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 text-lg font-semibold">
          <Link href={`/teacher/assignments/${a.id}`} className="break-words text-ink no-underline hover:underline">
            {a.title}
          </Link>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {/* While uploads are off, "Open" still shows: such an assignment takes uploads again once they are on. */}
          {(studentsCanUpload || a.status === "open") && <StatusBadge status={a.status} />}
          {a.released && <Badge tone="info">Feedback released</Badge>}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Count label="Papers" value={a.counts.total} />
        <Count label="To review" value={a.counts.needs_review} highlight={a.counts.needs_review > 0} />
        <Count label="In progress" value={inProgress} />
        <Count label="Graded" value={a.counts.graded} />
      </dl>

      {step && (
        <Link
          href={step.href}
          className={cx(
            "flex min-h-11 items-center rounded-lg border px-3 py-2 text-sm font-medium no-underline hover:underline",
            TONE_CLASSES[step.tone],
          )}
        >
          {step.text} →
        </Link>
      )}

      <p className="text-xs text-muted">
        {studentsCanUpload && (
          <>
            Code <span className="font-mono font-semibold tracking-wider text-ink">{formatShareCode(a.shareCode)}</span> ·{" "}
          </>
        )}
        Created <LocalTime ms={a.createdAt} />
      </p>
    </article>
  );
}

function Count({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("text-base font-semibold tabular-nums", highlight && "text-warning-800")}>{value}</dd>
    </div>
  );
}
