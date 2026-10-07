import type { Metadata } from "next";
import { connection } from "next/server";
import { AssignmentCard } from "@/components/teacher/assignment-card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireTeacher } from "@/lib/auth/dal";
import { getDashboardView } from "@/lib/services/views";

export const metadata: Metadata = { title: "Assignments" };

export default async function TeacherDashboardPage() {
  await connection();
  const teacher = await requireTeacher();
  const view = getDashboardView(teacher);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Assignments</h1>
        <LinkButton href="/teacher/assignments/new">New assignment</LinkButton>
      </div>

      {view.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          body="Create an assignment, add its answer key, then share the link with your students. The AI reads each paper against your key and you review anything it flags."
          action={<LinkButton href="/teacher/assignments/new">Create your first assignment</LinkButton>}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {view.assignments.map((assignment) => (
            <li key={assignment.id} className="flex min-w-0 flex-col [&>article]:flex-1">
              <AssignmentCard assignment={assignment} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
