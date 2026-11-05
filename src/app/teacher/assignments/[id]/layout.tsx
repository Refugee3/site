import type { Metadata } from "next";
import Link from "next/link";
import { assignmentSteps } from "@/components/teacher/assignment-steps";
import { AssignmentStepsGuide } from "@/components/teacher/assignment-steps-guide";
import { AssignmentTabs } from "@/components/teacher/assignment-tabs";
import { EditableTitle } from "@/components/teacher/editable-title";
import { HiddenWhileReviewing } from "@/components/teacher/hidden-while-reviewing";
import { plural } from "@/components/teacher/text";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { formatPoints, KIND_LABEL, PROJECT_MODE_LABEL } from "@/lib/format";
import { isPlaceholderTitle } from "@/lib/grading/key-questions";
import { getAssignmentHeader } from "@/lib/services/views";

type Props = LayoutProps<"/teacher/assignments/[id]">;

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { assignment } = await requireOwnedAssignment((await params).id);
  return { title: assignment.title };
}

// Not an auth boundary: each page below checks ownership again through the DAL.
export default async function AssignmentLayout({ params, children }: Props) {
  const { id } = await params;
  const { assignment } = await requireOwnedAssignment(id);
  const header = getAssignmentHeader(assignment);

  return (
    <>
      <div className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link href={`/teacher?type=${assignment.kind}`} className="text-muted">
            {assignment.kind === "quiz" ? "Quizzes" : assignment.kind === "project" ? "Projects" : "Homework"}
          </Link>
          <span aria-hidden="true"> / </span>
          <span className="text-ink">{assignment.title}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <EditableTitle
            assignmentId={assignment.id}
            title={assignment.title}
            placeholder={isPlaceholderTitle(assignment.title)}
            note={isPlaceholderTitle(assignment.title) && header.keyStatus === "processing" && assignment.kind !== "project"
              ? "The AI names it once it has read the key."
              : null}
          />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span>{KIND_LABEL[assignment.kind]}</span>
          {assignment.kind === "project" && (
            <>
              <span aria-hidden="true">·</span>
              <span>{PROJECT_MODE_LABEL[assignment.projectMode ?? "points"]}</span>
            </>
          )}
          {header.itemCount > 0 && assignment.kind !== "project" && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {plural(header.itemCount, "question")}, {formatPoints(header.totalPointsCenti)} points
                {(header.skippedCount ?? 0) > 0 && <> ({header.skippedCount} more not graded)</>}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>{plural(header.counts.total, "paper")}</span>
          {header.counts.needs_review > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-semibold text-warning-800">{header.counts.needs_review} to check</span>
            </>
          )}
          {!assignment.writeNotes && assignment.kind !== "project" && (
            <>
              <span aria-hidden="true">·</span>
              <Link href={`/teacher/assignments/${assignment.id}/settings`} title="The AI doesn't write feedback notes. Change it in Settings." className="text-muted">
                Feedback notes off
              </Link>
            </>
          )}
        </p>
      </div>

      {/* On a paper's review page and a scan's split check, the guide would only push the work down the screen. */}
      <HiddenWhileReviewing>
        <AssignmentStepsGuide steps={assignmentSteps(header, assignment.id, assignment.kind)} />
      </HiddenWhileReviewing>

      <AssignmentTabs
        assignmentId={assignment.id}
        needsReviewCount={header.counts.needs_review}
        keyNeedsAttention={!header.keyApproved && header.keyStatus !== "processing"}
        project={assignment.kind === "project"}
      />

      {children}
    </>
  );
}
