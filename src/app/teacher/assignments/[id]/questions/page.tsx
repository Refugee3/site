import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { boardRefreshMs } from "@/components/teacher/board-helpers";
import { OutcomeLegend, QuestionStatsTable } from "@/components/teacher/question-stats";
import { plural } from "@/components/teacher/text";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { formatPercent } from "@/lib/format";
import { MISS_HIGHLIGHT_MIN_PAPERS, MISS_HIGHLIGHT_MIN_TENTHS } from "@/lib/grading/item-stats";
import { getQuestionsView } from "@/lib/services/views";

export default async function QuestionsPage(props: PageProps<"/teacher/assignments/[id]/questions">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const { stats, active, open } = getQuestionsView(assignment);
  const threshold = formatPercent(MISS_HIGHLIGHT_MIN_TENTHS);

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
          How the class did on each question, from each student&apos;s latest paper once it&apos;s graded (papers waiting
          for your review count too). An answer counts as missed if it didn&apos;t get full credit for being right — wrong,
          blank or unreadable, or partly right by the credit it lost — whatever the grading mode, and your point changes
          count. Questions missed by {threshold} or more, once at least {MISS_HIGHLIGHT_MIN_PAPERS} papers are graded,
          are highlighted.
        </p>
      </div>

      {stats.items.length === 0 ? (
        <EmptyState title="No questions yet" body="Add the answer key first: the questions come from it." />
      ) : stats.countedPapers === 0 ? (
        <EmptyState title="No graded papers yet" body="The numbers appear here as papers are graded." />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">
              {plural(stats.countedPapers, "graded paper")} ·{" "}
              {stats.highlighted.length === 0
                ? `no question missed by ${threshold} or more`
                : `${plural(stats.highlighted.length, "question")} missed by ${threshold} or more`}
            </p>
            <OutcomeLegend />
          </div>
          <QuestionStatsTable assignmentId={assignment.id} stats={stats} />
        </>
      )}

      <AutoRefresh intervalMs={boardRefreshMs({ active, open })} />
    </div>
  );
}
