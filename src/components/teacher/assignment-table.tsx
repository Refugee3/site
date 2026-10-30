import Link from "next/link";
import { cx } from "@/components/ui/cx";
import { LocalTime } from "@/components/ui/local-time";
import { formatPercent, KIND_LABEL } from "@/lib/format";
import type { DashboardView } from "@/lib/types";
import { nextStep } from "./next-step";

type Row = DashboardView["assignments"][number];

const STEP_TEXT: Record<"info" | "warning" | "danger" | "success" | "neutral", string> = {
  info: "text-brand-600",
  warning: "text-warning-800 font-semibold",
  danger: "text-danger-700 font-semibold",
  success: "text-success-800",
  neutral: "text-muted",
};

/**
 * The dashboard's gradebook: one row per homework or quiz with its papers, how many are graded and waiting for the
 * teacher, the class average and the next step. A table from `md` up; a list of rows on phones.
 */
export function AssignmentTable({ assignments }: { assignments: Row[] }) {
  return (
    <div className="rounded-md border border-line bg-surface">
      <table className="hidden w-full text-left text-sm md:table">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="px-4 py-2.5 font-medium">Assignment</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Papers</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Graded</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">To check</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Average</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Next</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {assignments.map((a) => {
            const step = nextStep(a);
            const graded = a.counts.graded + a.counts.needs_review;
            return (
              <tr key={a.id} className="align-top hover:bg-canvas">
                <td className="px-4 py-3">
                  <Link href={`/teacher/assignments/${a.id}`} className="font-serif text-base font-semibold text-ink no-underline hover:underline">
                    {a.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {KIND_LABEL[a.kind]} · <LocalTime ms={a.createdAt} />
                  </p>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{a.counts.total}</td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {graded}
                  {a.progress && <span className="block text-xs text-muted">grading {a.progress.total - a.progress.done}</span>}
                </td>
                <td className={cx("px-3 py-3 text-right tabular-nums", a.counts.needs_review > 0 && "font-semibold text-warning-800")}>
                  {a.counts.needs_review}
                </td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{average(a)}</td>
                <td className="px-4 py-3">
                  <Link href={step.href} className={cx("no-underline hover:underline", STEP_TEXT[step.tone])}>
                    {stepText(step.text)}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ul className="divide-y divide-line md:hidden">
        {assignments.map((a) => {
          const step = nextStep(a);
          const graded = a.counts.graded + a.counts.needs_review;
          return (
            <li key={a.id} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <Link href={`/teacher/assignments/${a.id}`} className="min-w-0 break-words font-serif text-base font-semibold text-ink no-underline">
                  {a.title}
                </Link>
                <span className="shrink-0 font-semibold tabular-nums">{average(a)}</span>
              </div>
              <p className="text-xs text-muted">
                {KIND_LABEL[a.kind]} · {graded} of {a.counts.total} graded
                {a.counts.needs_review > 0 && <span className="font-semibold text-warning-800"> · {a.counts.needs_review} to check</span>}
              </p>
              <Link href={step.href} className={cx("text-sm no-underline", STEP_TEXT[step.tone])}>
                {stepText(step.text)}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function average(a: Row): string {
  return a.averageTenths === null || a.averageTenths === undefined ? "—" : formatPercent(a.averageTenths);
}

/** The next step without its "Next: " lead-in, which the column heading already says. */
function stepText(text: string): string {
  const plain = text.replace(/^Next: /, "");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}
