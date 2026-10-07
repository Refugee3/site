"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cx } from "@/components/ui/cx";

export interface AssignmentTabsProps {
  assignmentId: string;
  needsReviewCount: number;
  /** The key still needs the teacher (empty, failed or not approved). */
  keyNeedsAttention: boolean;
  /** Off: the teacher uploads all the homework, so the upload tab is named for that. */
  studentsCanUpload: boolean;
}

/**
 * The assignment's pages. On phones the tabs wrap onto a second row, so every tab (Settings too) is in view;
 * from `sm` up they stay on one row, scrolling sideways only if the notes make them too wide, with the
 * current tab brought into view.
 */
export function AssignmentTabs({ assignmentId, needsReviewCount, keyNeedsAttention, studentsCanUpload }: AssignmentTabsProps) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  // Scrolls the strip itself (not the page) so the current tab is visible after a full page load.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const strip = nav.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < strip.left || tab.right > strip.right) nav.scrollLeft += tab.left - strip.left - 16;
  }, [pathname]);

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
    {
      href: `${base}/upload`,
      label: studentsCanUpload ? "Upload papers" : "Upload homework",
      // A scan's split is checked on its own page, under the Upload tab.
      active: pathname === `${base}/upload` || pathname.startsWith(`${base}/scans/`),
      note: null,
    },
    { href: `${base}/lessons`, label: "Lessons", active: pathname === `${base}/lessons`, note: null },
    { href: `${base}/settings`, label: "Settings", active: pathname === `${base}/settings`, note: null },
  ];

  return (
    <nav ref={navRef} aria-label="Assignment" className="sm:overflow-x-auto">
      <ul className="flex flex-wrap gap-x-1 border-b border-line sm:min-w-max sm:flex-nowrap">
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
