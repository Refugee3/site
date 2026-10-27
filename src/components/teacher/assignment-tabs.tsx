"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cx } from "@/components/ui/cx";
import { ChartIcon, KeyIcon, LayersIcon, LightbulbIcon, SettingsIcon, UploadIcon } from "@/components/ui/icons";

export interface AssignmentTabsProps {
  assignmentId: string;
  needsReviewCount: number;
  /** The key still needs the teacher (empty, failed or not approved). */
  keyNeedsAttention: boolean;
}

/**
 * The assignment's pages. On phones the tabs wrap onto a second row, so every tab (Settings too) is in view;
 * from `sm` up they stay on one row, scrolling sideways only if the notes make them too wide, with the
 * current tab brought into view.
 */
export function AssignmentTabs({ assignmentId, needsReviewCount, keyNeedsAttention }: AssignmentTabsProps) {
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
      label: "Workspace", Icon: LayersIcon,
      // The live workspace: the key, the students' work, grading and the results. The review page belongs to it.
      active: pathname === base || pathname.startsWith(`${base}/submissions/`),
      note: needsReviewCount > 0 ? `${needsReviewCount} to check` : null,
    },
    { href: `${base}/key`, label: "Answer key", Icon: KeyIcon, active: pathname === `${base}/key`, note: keyNeedsAttention ? "needs you" : null },
    {
      href: `${base}/upload`,
      label: "Upload work", Icon: UploadIcon,
      // A scan's split is checked on its own page, under the Upload tab.
      active: pathname === `${base}/upload` || pathname.startsWith(`${base}/scans/`),
      note: null,
    },
    { href: `${base}/questions`, label: "Questions", Icon: ChartIcon, active: pathname === `${base}/questions`, note: null },
    { href: `${base}/lessons`, label: "Lessons", Icon: LightbulbIcon, active: pathname === `${base}/lessons`, note: null },
    { href: `${base}/settings`, label: "Settings", Icon: SettingsIcon, active: pathname === `${base}/settings`, note: null },
  ];

  return (
    <nav ref={navRef} aria-label="Assignment" className="sm:overflow-x-auto">
      <ul className="flex flex-wrap gap-1 rounded-2xl border border-line bg-surface p-1.5 shadow-xs sm:w-max sm:min-w-full sm:flex-nowrap">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={cx(
                "flex min-h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold no-underline transition",
                tab.active
                  ? "bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-[0_4px_12px_-4px_rgb(79_70_229/0.5)]"
                  : "text-muted hover:bg-subtle hover:text-ink",
              )}
            >
              <tab.Icon className="size-4" />
              {tab.label}
              {tab.note && (
                <span className="rounded-full border border-warning-200 bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-800">
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
