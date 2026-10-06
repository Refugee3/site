import Link from "next/link";
import { logoutAction } from "@/actions/auth";
import { WorkerBanner } from "@/components/teacher/worker-banner";
import { APP_NAME } from "@/components/ui/public-page";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireTeacher } from "@/lib/auth/dal";
import { getWorkerStatus } from "@/lib/jobs/queue";

// Not an auth boundary (layouts are not re-checked on navigation): every teacher page calls the DAL itself.
export default async function TeacherLayout({ children }: LayoutProps<"/teacher">) {
  const teacher = await requireTeacher();

  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex min-h-14 w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-1">
          <Link href="/teacher" className="text-base font-semibold text-ink no-underline">
            {APP_NAME}
          </Link>
          <nav aria-label="Teacher" className="flex items-center">
            <Link href="/teacher" className="flex min-h-11 items-center text-sm font-medium text-ink no-underline hover:underline">
              Assignments
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="max-w-48 truncate text-sm text-muted">{teacher.displayName}</span>
            <form action={logoutAction}>
              <SubmitButton variant="ghost" size="sm" pendingText="Logging out…">
                Log out
              </SubmitButton>
            </form>
          </div>
        </div>
      </header>
      <WorkerBanner worker={getWorkerStatus()} />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6">{children}</main>
    </>
  );
}
