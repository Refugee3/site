import { cx } from "./cx";

export interface ProgressBarProps {
  /** How far along, 0..1 (clamped). */
  value: number;
  /** The accessible name ("Grading papers"); not shown. */
  label: string;
  /** What a screen reader says for the value ("3 of 10 papers graded"); defaults to the percentage. */
  valueText?: string;
  /**
   * The position is an estimate (time elapsed against a typical time), not counted work: the fill gets moving stripes
   * (none with reduced motion) and the default value text says "About N%".
   */
  estimated?: boolean;
  /** "sm" is a thin bar for cards and lists. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * A progress bar (role="progressbar", 0–100). The fill slides smoothly to each new value and stands still for people
 * who prefer reduced motion. Pure markup, so it renders the same on the server and in the browser.
 */
export function ProgressBar({ value, label, valueText, estimated = false, size = "md", className }: ProgressBarProps) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const percent = Math.round(fraction * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText ?? (estimated ? `About ${percent}%` : `${percent}%`)}
      className={cx(
        "w-full min-w-0 overflow-hidden rounded-full bg-subtle ring-1 ring-line ring-inset",
        size === "sm" ? "h-1.5" : "h-2.5",
        className,
      )}
    >
      <div
        className={cx(
          "h-full rounded-full bg-brand-600 transition-[width] duration-700 ease-out motion-reduce:transition-none",
          estimated && "progress-stripes motion-safe:animate-progress-stripes",
        )}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}
