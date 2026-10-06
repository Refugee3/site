"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/cx";

export interface AssignmentTabsProps {
  assignmentId: string;
  needsReviewCount: number;
  /** The key still needs the teacher (empty, failed or not approved). */
  keyNeedsAttention: boolean;
}

export function AssignmentTabs({ assignmentId, needsReviewCount, keyNeedsAttention }: AssignmentTabsProps) {
  const pathname = usePathname();
  const base = `/teacher/assignments/${assignmentId}`;
  const tabs = [
    {
      href: base,
      label: "Submissions",
      // The review page belongs to the Submissions tab.
      active: pathname === base || pathname.startsWith(`${base}/submissions/`),
      note: needsReviewCount > 0 ? `${needsReviewCount} to review` : null,
    },
    { href: `${base}/key`, label: "Answer key", active: pathname === `${base}/key`, note: keyNeedsAttention ? "needs you" : null },
    { href: `${base}/upload`, label: "Upload papers", active: pathname === `${base}/upload`, note: null },
    { href: `${base}/settings`, label: "Settings", active: pathname === `${base}/settings`, note: null },
  ];

  return (
    <nav aria-label="Assignment" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={cx(
                "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium no-underline",
                tab.active ? "border-brand-600 text-ink" : "border-transparent text-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {tab.label}
              {tab.note && (
                <span className="rounded-full border border-warning-200 bg-warning-50 px-2 py-0.5 text-xs text-warning-800">
                  {tab.note}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
