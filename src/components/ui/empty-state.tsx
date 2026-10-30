import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}

/** A placeholder for lists with nothing in them yet. */
export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line-strong bg-surface px-5 py-8">
      <p className="font-serif text-lg font-semibold text-ink">{title}</p>
      {body && <div className="max-w-prose text-sm text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
