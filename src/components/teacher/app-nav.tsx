"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cx } from "@/components/ui/cx";

type NavKey = "all" | "homework" | "quiz" | "settings";

const ITEMS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "all", href: "/teacher", label: "Assignments" },
  { key: "homework", href: "/teacher?type=homework", label: "Homework" },
  { key: "quiz", href: "/teacher?type=quiz", label: "Quizzes" },
  { key: "settings", href: "/teacher/settings", label: "Settings" },
];

function activeKey(pathname: string, type: string | null): NavKey {
  if (pathname.startsWith("/teacher/settings")) return "settings";
  if (pathname === "/teacher" && type === "homework") return "homework";
  if (pathname === "/teacher" && type === "quiz") return "quiz";
  return "all";
}

/** The teacher area's main links in the navy bar; the current page is underlined in gold. */
export function AppNav() {
  const pathname = usePathname();
  const type = useSearchParams().get("type");
  return <AppNavLinks active={activeKey(pathname, type)} />;
}

/** The links without the current page marked (while the address isn't known yet). */
export function AppNavLinks({ active }: { active: NavKey | null }) {
  return (
    <ul className="flex gap-1 overflow-x-auto sm:gap-2">
      {ITEMS.map(({ key, href, label }) => {
        const current = key === active;
        return (
          <li key={key} className="shrink-0">
            <Link
              href={href}
              aria-current={current ? "page" : undefined}
              className={cx(
                "flex min-h-11 items-center border-b-[3px] px-2 pt-[3px] text-sm no-underline sm:px-3",
                current ? "border-gold-400 font-semibold text-white" : "border-transparent text-white/75 hover:text-white",
              )}
            >
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
