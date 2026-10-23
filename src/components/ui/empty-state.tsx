import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}

/** A centered placeholder for lists with nothing in them yet. */
export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-4 py-10 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {body && <div className="max-w-md text-sm text-muted">{body}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
