import Link from "next/link";
import { connection } from "next/server";
import { LessonCard, LessonListGuard } from "@/components/teacher/lesson-card";
import { RegradeGuidanceButton } from "@/components/teacher/regrade-guidance-button";
import { plural } from "@/components/teacher/text";
import { EmptyState } from "@/components/ui/empty-state";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { getLessonsView } from "@/lib/services/views";
import type { LessonView } from "@/lib/types";

/** The view's lessons (key order, newest first within an item) in one group per key item. */
function byItem(lessons: LessonView[]): LessonView[][] {
  const groups: LessonView[][] = [];
  for (const entry of lessons) {
    const last = groups.at(-1);
    if (last && last[0].lesson.itemId === entry.lesson.itemId) last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

export default async function LessonsPage(props: PageProps<"/teacher/assignments/[id]/lessons">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const view = getLessonsView(assignment);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Lessons</h2>
        <p className="text-muted">
          When you correct the AI on a paper — the points, the feedback or “What you did” — the correction becomes a
          lesson. The grader reads your active lessons and your grading preferences every time it grades a paper for
          this assignment. It isn&apos;t retrained: lessons are notes it reads each time. A lesson stays with your
          correction on its paper: turn it off to stop the grader using it.
        </p>
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">
            {plural(view.lessons.length, "lesson")} · {view.sentCount} sent to the grader
          </span>
          <Link href="/teacher/settings">Edit your grading preferences</Link>
        </p>
        <RegradeGuidanceButton assignmentId={assignment.id} count={view.guidanceStaleCount} />
      </div>

      {view.lessons.length === 0 ? (
        <EmptyState
          title="No lessons yet"
          body="Open a paper, correct the AI's points or feedback, and say why. The grader uses it on the next papers."
        />
      ) : (
        <LessonListGuard lessonIds={view.lessons.map((entry) => entry.lesson.id)}>
          {byItem(view.lessons).map((group) => (
            <section key={group[0].lesson.itemId} className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Question {group[0].itemLabel}</h3>
              <ul className="flex flex-col gap-3">
                {group.map((entry) => (
                  <li key={entry.lesson.id}>
                    <LessonCard entry={entry} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </LessonListGuard>
      )}
    </div>
  );
}
