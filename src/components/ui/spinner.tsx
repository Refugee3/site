import { cx } from "./cx";

/**
 * An animated activity indicator. Decorative by default (next to text that already says what is happening);
 * pass `label` when the spinner stands alone so screen readers announce it. `className` replaces the default
 * size ("size-5"), so include a size when passing it.
 */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  const svg = (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cx("shrink-0 animate-spin motion-reduce:animate-none", className ?? "size-5")}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
  if (!label) return svg;
  return (
    <span role="status" className="inline-flex items-center">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
