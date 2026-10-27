import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  /** A large icon above the title. */
  icon?: ReactNode;
}

/** A centered placeholder for lists with nothing in them yet. */
export function EmptyState({ title, body, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface px-4 py-12 text-center">
      {icon && <div className="mb-2 grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600 [&>svg]:size-7">{icon}</div>}
      <p className="text-lg font-semibold text-ink">{title}</p>
      {body && <div className="max-w-md text-sm text-muted">{body}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
