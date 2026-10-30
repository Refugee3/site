import Link from "next/link";
import { Suspense } from "react";
import { logoutAction } from "@/actions/auth";
import { AppNav, AppNavLinks } from "@/components/teacher/app-nav";
import { WorkerBanner } from "@/components/teacher/worker-banner";
import { Logo } from "@/components/ui/logo";
import { APP_NAME } from "@/components/ui/public-page";
import { requireTeacher } from "@/lib/auth/dal";
import { getWorkerStatus } from "@/lib/jobs/queue";

// Not an auth boundary (layouts are not re-checked on navigation): every teacher page calls the DAL itself.
export default async function TeacherLayout({ children }: LayoutProps<"/teacher">) {
  const teacher = await requireTeacher();

  return (
    <>
      <header className="bg-brand-600 text-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 px-4 sm:px-6">
          <Link href="/teacher" className="flex min-h-14 items-center no-underline" aria-label={`${APP_NAME}: your assignments`}>
            <Logo onDark />
          </Link>
          {/* On phones the links take their own row under the name and "Log out". */}
          <nav aria-label="Main" className="order-last -mx-2 w-full sm:order-none sm:mx-0 sm:w-auto sm:self-end">
            <Suspense fallback={<AppNavLinks active={null} />}>
              <AppNav />
            </Suspense>
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="hidden max-w-48 truncate text-white/75 md:block">{teacher.displayName}</span>
            <form action={logoutAction}>
              <button type="submit" className="min-h-11 text-white underline-offset-2 hover:underline">
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>
      <WorkerBanner worker={getWorkerStatus()} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </>
  );
}
