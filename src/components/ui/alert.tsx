import type { ReactNode } from "react";
import { cx } from "./cx";
import { TONE_CLASSES, type Tone } from "./tone";

export interface AlertProps {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A boxed message. Danger alerts are announced immediately; the others politely. */
export function Alert({ tone, title, children, className }: AlertProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("rounded-lg border px-4 py-3 text-sm leading-relaxed", TONE_CLASSES[tone], className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-1" : undefined}>{children}</div>}
    </div>
  );
}
