import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { boardRefreshMs } from "@/components/teacher/board-helpers";
import { MissedQuestionsCard, MOST_MISSED_TITLE, OutcomeLegend, QuestionStatsTable } from "@/components/teacher/question-stats";
import { plural } from "@/components/teacher/text";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { MISS_HIGHLIGHT_MIN_PAPERS } from "@/lib/grading/item-stats";
import { getQuestionsView } from "@/lib/services/views";

export default async function QuestionsPage(props: PageProps<"/teacher/assignments/[id]/questions">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const { stats, active } = getQuestionsView(assignment);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Questions</h2>
          {stats.items.length > 0 && (
            <LinkButton href={`/api/teacher/assignments/${assignment.id}/export/questions`} variant="secondary" size="sm" download>
              Download question stats (CSV)
            </LinkButton>
          )}
        </div>
        <p className="max-w-3xl text-muted">
          How the class did on each question, from each student&apos;s latest graded paper (papers waiting for your check
          count too). An answer counts as missed if it wasn&apos;t fully right — wrong, blank or unreadable, or partly right
          by the credit it lost — and your point changes count. Questions more than half the class missed are highlighted
          as &ldquo;{MOST_MISSED_TITLE.toLowerCase()}&rdquo; once at least {MISS_HIGHLIGHT_MIN_PAPERS} papers are graded.
        </p>
      </div>

      {stats.items.length === 0 ? (
        <EmptyState
          title="No questions yet"
          body="The questions come from the answer key. Add it and approve it first."
          action={<LinkButton href={`/teacher/assignments/${assignment.id}/key`}>Add the answer key</LinkButton>}
        />
      ) : stats.countedPapers === 0 ? (
        <EmptyState
          title="No graded papers yet"
          body="Upload the students' work. The numbers for each question appear here as papers are graded."
          action={<LinkButton href={`/teacher/assignments/${assignment.id}/upload`}>Upload students&apos; work</LinkButton>}
        />
      ) : (
        <>
          <MissedQuestionsCard assignmentId={assignment.id} stats={stats} activeItemId={null} onQuestionsTab />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">
              {plural(stats.countedPapers, "graded paper")} ·{" "}
              {stats.highlighted.length === 0
                ? "no question was missed by most of the class"
                : `${plural(stats.highlighted.length, "question")} most of the class got wrong`}
            </p>
            <OutcomeLegend />
          </div>
          <QuestionStatsTable assignmentId={assignment.id} stats={stats} />
        </>
      )}

      <AutoRefresh intervalMs={boardRefreshMs({ active })} />
    </div>
  );
}
