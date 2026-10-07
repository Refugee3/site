import type { Metadata } from "next";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { AssignmentCard } from "@/components/teacher/assignment-card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireTeacher } from "@/lib/auth/dal";
import { getDashboardView } from "@/lib/services/views";

export const metadata: Metadata = { title: "Assignments" };

/** While any paper is being graded, a scan split or a key read, so the cards' bars and next steps keep up. */
const BUSY_POLL_MS = 4000;

export default async function TeacherDashboardPage() {
  await connection();
  const teacher = await requireTeacher();
  const view = getDashboardView(teacher);
  const busy = view.assignments.some((a) => a.progress !== null || a.scans.splitting > 0 || a.keyStatus === "processing");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Assignments</h1>
        <LinkButton href="/teacher/assignments/new">New assignment</LinkButton>
      </div>

      {view.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          body={
            view.studentsCanUpload
              ? "Create an assignment, add its answer key, then share the link with your students. The AI reads each paper against your key and you review anything it flags."
              : "Create an assignment, add its answer key, then upload your students' homework. The AI reads each paper against your key and you review anything it flags."
          }
          action={<LinkButton href="/teacher/assignments/new">Create your first assignment</LinkButton>}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {view.assignments.map((assignment) => (
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
