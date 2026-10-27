"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cx } from "@/components/ui/cx";
import { BookIcon, HomeIcon, QuizIcon, SettingsIcon } from "@/components/ui/icons";

type NavKey = "dashboard" | "homework" | "quiz" | "settings";

const ITEMS: Array<{ key: NavKey; href: string; label: string; Icon: typeof HomeIcon }> = [
  { key: "dashboard", href: "/teacher", label: "Dashboard", Icon: HomeIcon },
  { key: "homework", href: "/teacher?type=homework", label: "Homework", Icon: BookIcon },
  { key: "quiz", href: "/teacher?type=quiz", label: "Quizzes", Icon: QuizIcon },
  { key: "settings", href: "/teacher/settings", label: "Settings", Icon: SettingsIcon },
];

function activeKey(pathname: string, type: string | null): NavKey {
  if (pathname.startsWith("/teacher/settings")) return "settings";
  if (pathname === "/teacher" && type === "homework") return "homework";
  if (pathname === "/teacher" && type === "quiz") return "quiz";
  return "dashboard";
}

/**
 * The teacher area's main links: a column in the dark sidebar ("sidebar") or a row of pills under the top bar on phones
 * and tablets ("bar"). The current page is marked from the address (a homework or quiz filter counts as its own page).
 */
export function AppNav({ variant }: { variant: "sidebar" | "bar" }) {
  const pathname = usePathname();
  const type = useSearchParams().get("type");
  return <AppNavLinks variant={variant} active={activeKey(pathname, type)} />;
}

/** The links without the current page (while the address isn't known yet). */
export function AppNavLinks({ variant, active }: { variant: "sidebar" | "bar"; active: NavKey | null }) {
  return (
    <ul className={variant === "sidebar" ? "flex flex-col gap-1" : "grid grid-cols-4 gap-1"}>
      {ITEMS.map(({ key, href, label, Icon }) => {
        const current = key === active;
        return (
          <li key={key} className="min-w-0">
            <Link
              href={href}
              aria-current={current ? "page" : undefined}
              className={cx(
                "flex min-h-11 rounded-xl font-medium no-underline transition",
                variant === "sidebar" ? "items-center gap-3 px-3 text-sm" : "flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs",
                variant === "sidebar"
                  ? current
                    ? "bg-white/10 text-white shadow-[inset_3px_0_0_var(--color-ember-500)]"
                    : "text-night-300 hover:bg-white/5 hover:text-white"
                  : current
                    ? "bg-brand-600 text-white"
                    : "text-muted hover:bg-subtle hover:text-ink",
              )}
            >
              <Icon className={cx(variant === "sidebar" && current && "text-ember-400")} />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
