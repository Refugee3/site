import type { ReactNode } from "react";
import { cx } from "./cx";

/** A small progress ring (0..1) with something in its middle; `label` names it for screen readers. */
export function Ring({ value, label, children, className, tone = "brand" }: {
  value: number; label: string; children?: ReactNode; className?: string; tone?: "brand" | "gold" | "success";
}) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const r = 20;
  const circumference = 2 * Math.PI * r;
  const stroke = tone === "gold" ? "var(--color-gold-500)" : tone === "success" ? "var(--color-success-600)" : "var(--color-brand-600)";
  return (
    <div role="img" aria-label={label} className={cx("relative grid size-16 shrink-0 place-items-center", className)}>
      <svg viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--color-subtle)" strokeWidth="5" />
        <circle
          cx="24" cy="24" r={r} fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${fraction * circumference} ${circumference}`}
          className="transition-[stroke-dasharray] duration-700 motion-reduce:transition-none"
        />
      </svg>
      <span className="relative text-sm font-bold tabular-nums text-ink">{children}</span>
    </div>
  );
}
