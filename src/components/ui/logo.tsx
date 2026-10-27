import { cx } from "./cx";

/** DragonGrader's mark: a flame (the dragon's fire) holding a check mark. Decorative: the name is always next to it. */
/**
 * `id` names the flame's gradient: each mark on a page needs its own, since a mark hidden with display:none (the sidebar
 * on phones) can't lend its gradient to the others.
 */
export function LogoMark({ className, id = "dragongrader-fire" }: { className?: string; id?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={cx("size-7 shrink-0", className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#c0332b" />
          <stop offset="1" stopColor="#f08a24" />
        </linearGradient>
      </defs>
      <path
        d="M17.5 1.5c.6 4.2 3.4 6.4 5.6 9 2.2 2.6 3.4 5.2 3.4 8.6 0 6.3-4.9 11.4-10.5 11.4S5.5 25.4 5.5 19.4c0-3.6 1.7-6.6 4.3-8.8-.2 2.3.6 4.1 2 5.2.2-5.6 2.3-10.4 5.7-14.3z"
        fill={`url(#${id})`}
      />
      <path d="M10.8 20.2l3.6 3.6 7-8.2" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The mark and the name: "Dragon" in ink (white on the dark sidebar), "Grader" in the brand color (ember on dark). */
export function Logo({ className, onDark = false, id }: { className?: string; onDark?: boolean; id?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-lg font-bold tracking-tight", className)}>
      <LogoMark id={id} />
      <span>
        <span className={onDark ? "text-white" : "text-ink"}>Dragon</span>
        <span className={onDark ? "text-ember-400" : "text-brand-700"}>Grader</span>
      </span>
    </span>
  );
}
