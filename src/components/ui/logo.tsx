import { cx } from "./cx";

/** DragonGrader's mark: a Drexel Blue shield with a gold rim and a gold check mark. Decorative: the name is always next to it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={cx("size-7 shrink-0", className)}>
      <path
        d="M16 2.2 27.4 6.4v8.4c0 7.3-4.8 12.3-11.4 14.9C9.4 27.1 4.6 22.1 4.6 14.8V6.4z"
        fill="var(--color-brand-600)"
        stroke="var(--color-gold-400)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="m10.6 15.6 3.9 3.9 7.2-8.3" fill="none" stroke="var(--color-gold-400)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The mark and the name: "Dragon" in Drexel Blue and "Grader" in a lighter blue; on the dark sidebar, white and gold. */
export function Logo({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-lg font-bold tracking-tight", className)}>
      <LogoMark />
      <span>
        <span className={onDark ? "text-white" : "text-brand-600"}>Dragon</span>
        <span className={onDark ? "text-gold-400" : "text-brand-500"}>Grader</span>
      </span>
    </span>
  );
}
