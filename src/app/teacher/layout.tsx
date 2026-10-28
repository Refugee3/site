import Link from "next/link";
import { Suspense } from "react";
import { logoutAction } from "@/actions/auth";
import { AppNav, AppNavLinks } from "@/components/teacher/app-nav";
import { WorkerBanner } from "@/components/teacher/worker-banner";
import { LogOutIcon, PlusIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";
import { APP_NAME } from "@/components/ui/public-page";
import { requireTeacher } from "@/lib/auth/dal";
import { getWorkerStatus } from "@/lib/jobs/queue";

/** "Maria Lopez" → "ML". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase() || "T";
}

// Not an auth boundary (layouts are not re-checked on navigation): every teacher page calls the DAL itself.
export default async function TeacherLayout({ children }: LayoutProps<"/teacher">) {
  const teacher = await requireTeacher();
  const logout = (
    <form action={logoutAction}>
      <button
        type="submit"
        className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-current no-underline hover:bg-white/10"
      >
        <LogOutIcon />
        Log out
      </button>
    </form>
  );

  return (
    <div className="flex min-h-full flex-1">
      {/* Computers: a dark sidebar, always in view. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-gradient-to-b from-night-900 to-night-950 text-night-300 lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/teacher" className="no-underline" aria-label={`${APP_NAME}: your dashboard`}>
            <Logo onDark />
          </Link>
        </div>
        <div className="px-4 pb-4">
          <Link
            href="/teacher/assignments/new"
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gold-400 px-3 text-sm font-semibold text-night-900 no-underline shadow-[0_6px_18px_-6px_rgb(255_198_0/0.5)] hover:bg-gold-300"
          >
            <PlusIcon />
            New homework or quiz
          </Link>
        </div>
        <nav aria-label="Main" className="flex-1 px-3">
          <Suspense fallback={<AppNavLinks variant="sidebar" active={null} />}>
            <AppNav variant="sidebar" />
          </Suspense>
        </nav>
        <div className="flex flex-col gap-2 border-t border-white/10 p-4">
          <div className="flex items-center gap-3 px-1">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-night-700 text-sm font-semibold text-white" aria-hidden="true">
              {initials(teacher.displayName)}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-white">{teacher.displayName}</span>
          </div>
          {logout}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        {/* Phones and tablets: a top bar with the same links as pills. */}
        <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur lg:hidden">
          <div className="flex min-h-14 items-center justify-between gap-3 px-4">
            <Link href="/teacher" className="no-underline" aria-label={`${APP_NAME}: your dashboard`}>
              <Logo />
            </Link>
            <div className="text-muted">{logout}</div>
          </div>
          <nav aria-label="Main" className="px-3 pb-2">
            <Suspense fallback={<AppNavLinks variant="bar" active={null} />}>
              <AppNav variant="bar" />
            </Suspense>
          </nav>
        </header>
        <WorkerBanner worker={getWorkerStatus()} />
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
