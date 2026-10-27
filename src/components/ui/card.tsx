import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** An icon shown in a soft tile before the title. */
  icon?: ReactNode;
  /** The icon tile's color. */
  accent?: "brand" | "ember" | "danger" | "success" | "info";
}

const ACCENTS: Record<NonNullable<CardProps["accent"]>, string> = {
  brand: "bg-brand-50 text-brand-700",
  ember: "bg-ember-50 text-ember-700",
  danger: "bg-danger-50 text-danger-700",
  success: "bg-success-50 text-success-800",
  info: "bg-info-50 text-info-800",
};

/** A bordered surface with an optional heading row (icon and title on the left, actions on the right). */
export function Card({ title, actions, children, className, icon, accent = "brand" }: CardProps) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(20_23_51/0.04),0_8px_24px_-12px_rgb(20_23_51/0.12)]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-6">
          {title && (
            <h2 className="flex min-w-0 items-center gap-3 text-lg font-semibold text-ink">
              {icon && <span className={cx("grid size-9 shrink-0 place-items-center rounded-xl", ACCENTS[accent])}>{icon}</span>}
              <span className="min-w-0">{title}</span>
            </h2>
          )}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4 sm:p-6">{children}</div>
    </section>
  );
}
