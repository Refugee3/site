import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { AssignmentCard } from "@/components/teacher/assignment-card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireTeacher } from "@/lib/auth/dal";
import { getDashboardView } from "@/lib/services/views";
import type { AssignmentKind } from "@/lib/types";

export const metadata: Metadata = { title: "Assignments" };

/** While any paper is being graded, a scan split or a key read, so the cards' bars and next steps keep up. */
const BUSY_POLL_MS = 4000;

const KIND_FILTERS: Array<{ kind: AssignmentKind | null; label: string; href: string }> = [
  { kind: null, label: "All", href: "/teacher" },
  { kind: "homework", label: "Homework", href: "/teacher?type=homework" },
  { kind: "quiz", label: "Quizzes", href: "/teacher?type=quiz" },
];

export default async function TeacherDashboardPage(props: PageProps<"/teacher">) {
  await connection();
  const teacher = await requireTeacher();
  const view = getDashboardView(teacher);
  const type = (await props.searchParams).type;
  const kind: AssignmentKind | null = type === "homework" || type === "quiz" ? type : null;
  const shown = kind ? view.assignments.filter((a) => a.kind === kind) : view.assignments;
  // Polls for every assignment, shown or not, so switching filters never shows stale cards.
  const busy = view.assignments.some((a) => a.progress !== null || a.scans.splitting > 0 || a.keyStatus === "processing");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Assignments</h1>
        <LinkButton href={kind === "quiz" ? "/teacher/assignments/new?kind=quiz" : "/teacher/assignments/new"}>
          New homework or quiz
        </LinkButton>
      </div>

      {view.assignments.length > 0 && (
        <nav aria-label="Filter assignments by type">
          <ul className="flex flex-wrap gap-2">
            {KIND_FILTERS.map((option) => {
              const active = option.kind === kind;
              return (
                <li key={option.label}>
                  <Link
                    href={option.href}
                    scroll={false}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex min-h-11 items-center rounded-full border px-4 text-sm font-medium no-underline sm:min-h-9",
                      active ? "border-brand-600 bg-brand-600 text-white" : "border-line-strong bg-surface text-ink hover:bg-subtle",
                    )}
                  >
                    {option.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {view.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          body={
            view.studentsCanUpload
              ? "Create an assignment, add its answer key, then share the link with your students. The AI reads each paper against your key and you review anything it flags."
              : "Create an assignment, add its answer key, then upload your students' homework. The AI reads each paper against your key and you review anything it flags."
          }
          action={<LinkButton href="/teacher/assignments/new">Create your first homework or quiz</LinkButton>}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title={kind === "quiz" ? "No quizzes yet" : "No homework yet"}
          action={
            <LinkButton href={kind === "quiz" ? "/teacher/assignments/new?kind=quiz" : "/teacher/assignments/new"}>
              {kind === "quiz" ? "Create a quiz" : "Create homework"}
            </LinkButton>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((assignment) => (
            <li key={assignment.id} className="flex min-w-0 flex-col [&>article]:flex-1">
              <AssignmentCard assignment={assignment} studentsCanUpload={view.studentsCanUpload} />
            </li>
          ))}
        </ul>
      )}

      <AutoRefresh intervalMs={busy ? BUSY_POLL_MS : null} />
    </>
  );
}
