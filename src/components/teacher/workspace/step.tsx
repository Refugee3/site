import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

export type StepState = "done" | "current" | "waiting";

export interface WorkspaceStepProps {
  number: number;
  /** Used for the heading's id ("workspace-step-key"). */
  id: string;
  title: string;
  state: StepState;
  /** One short line beside the title on where the step stands. */
  status?: ReactNode;
  /** The last step draws no line down to a next one. */
  last?: boolean;
  children: ReactNode;
}

/** One card of the workspace's vertical flow: a numbered marker (a tick once done) joined to the next step by a line. */
export function WorkspaceStep({ number, id, title, state, status, last = false, children }: WorkspaceStepProps) {
  const headingId = `workspace-step-${id}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 gap-3 sm:gap-4">
      <div className="flex shrink-0 flex-col items-center pt-3" aria-hidden="true">
        <span
          className={cx(
            "flex size-8 items-center justify-center rounded-full text-sm font-semibold",
            state === "done" && "bg-success-600 text-white",
            state === "current" && "bg-brand-600 text-white ring-4 ring-brand-100",
            state === "waiting" && "border border-line-strong bg-surface text-muted",
          )}
        >
          {state === "done" ? (
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
          ) : (
            number
          )}
        </span>
        {!last && <span className={cx("mt-2 w-0.5 flex-1 rounded-full", state === "done" ? "bg-success-200" : "bg-line")} />}
      </div>
      <div
        className={cx(
          "mb-2 min-w-0 flex-1 rounded-xl border bg-surface shadow-sm",
          state === "current" ? "border-brand-600/40" : "border-line",
        )}
      >
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 sm:px-6">
          <h2 id={headingId} className="text-lg font-semibold text-ink">
            <span className="sr-only">Step {number}{state === "done" ? " (done)" : state === "current" ? " (now)" : ""}: </span>
            {title}
          </h2>
          {status && <p className="text-sm text-muted">{status}</p>}
        </header>
        <div className={cx("flex flex-col gap-4 p-4 sm:p-6", state === "waiting" && "text-muted")}>{children}</div>
      </div>
    </section>
  );
}
