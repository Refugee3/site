import Link from "next/link";
import { cx } from "@/components/ui/cx";
import type { AssignmentStep } from "./assignment-steps";

/**
 * "1. Add the answer key → 2. Upload students' work → 3. Review results", each a link to its tab with a tick once
 * done. One compact row per step on phones, three across from `sm` up.
 */
export function AssignmentStepsGuide({ steps }: { steps: AssignmentStep[] }) {
  return (
    <nav aria-label="Steps">
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <li key={step.number} className="flex min-w-0">
            <Link
              href={step.href}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cx(
                "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2 text-ink no-underline shadow-sm hover:bg-subtle",
                step.state === "current" ? "border-brand-600 bg-brand-50 ring-1 ring-brand-600" : "border-line bg-surface",
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                  step.state === "done" && "bg-success-600 text-white",
                  step.state === "current" && "bg-brand-600 text-white",
                  step.state === "todo" && "border border-line-strong bg-surface text-muted",
                )}
              >
                {step.state === "done" ? <Tick /> : step.number}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-semibold">
                  <span className="sr-only">Step {step.number}{step.state === "done" ? " (done)" : step.state === "current" ? " (next)" : ""}: </span>
                  {step.title}
                </span>
                <span className={cx("truncate text-xs", step.state === "current" ? "text-brand-800" : "text-muted")}>{step.status}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
