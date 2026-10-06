import type { ReactNode } from "react";
import { cx } from "./cx";
import { TONE_CLASSES, type Tone } from "./tone";

export interface BadgeProps {
  tone: Tone;
  children: ReactNode;
  /** Extra explanation shown on hover. */
  title?: string;
  className?: string;
}

export function Badge({ tone, children, title, className }: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
