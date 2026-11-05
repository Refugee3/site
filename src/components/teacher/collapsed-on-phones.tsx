"use client";

import { useId, useState, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";

export interface CollapsedOnPhonesProps {
  /** The one-line summary on the toggle that stands in for the content on phones. */
  summary: ReactNode;
  /** Classes of the content box (its layout from `md` up, where it always shows). */
  className?: string;
  children: ReactNode;
}

/**
 * Content that shows as is from `md` up, but sits behind a one-line toggle on phones, so what the teacher
 * came for (the tabs, the papers, the key) is not pushed below the first screen. CSS alone picks the
 * layout, so nothing jumps when the page hydrates.
 */
export function CollapsedOnPhones({ summary, className, children }: CollapsedOnPhonesProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-2 text-left text-sm shadow-sm md:hidden"
      >
        <span className="min-w-0">{summary}</span>
        <span className="shrink-0 font-medium text-brand-700">{open ? "Hide" : "Show"}</span>
      </button>
      <div id={id} className={cx(className, !open && "max-md:hidden")}>
        {children}
      </div>
    </>
  );
}
