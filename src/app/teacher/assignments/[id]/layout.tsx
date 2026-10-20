import type { Metadata } from "next";
import Link from "next/link";
import { assignmentSteps } from "@/components/teacher/assignment-steps";
import { AssignmentStepsGuide } from "@/components/teacher/assignment-steps-guide";
import { AssignmentTabs } from "@/components/teacher/assignment-tabs";
import { HiddenWhileReviewing } from "@/components/teacher/hidden-while-reviewing";
import { plural } from "@/components/teacher/text";
import { Badge } from "@/components/ui/badge";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { formatPoints, KIND_LABEL } from "@/lib/format";
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
        <Link href="/teacher" className="self-start text-sm">
          ← All assignments
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{assignment.title}</h1>
          <Badge tone={assignment.kind === "quiz" ? "info" : "neutral"}>{KIND_LABEL[assignment.kind]}</Badge>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          {header.itemCount > 0 && (
            <>
              <span>
                {plural(header.itemCount, "question")} · {formatPoints(header.totalPointsCenti)} points
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>{plural(header.counts.total, "paper")}</span>
          {!assignment.writeNotes && (
            <>
              <span aria-hidden="true">·</span>
              <Link href={`/teacher/assignments/${assignment.id}/settings`} title="The AI doesn't write feedback notes. Change it in Settings.">
                Feedback notes off
              </Link>
            </>
          )}
        </p>
      </div>

      {/* On a paper's review page and a scan's split check, the guide would only push the work down the screen. */}
      <HiddenWhileReviewing>
        <AssignmentStepsGuide steps={assignmentSteps(header, assignment.id)} />
      </HiddenWhileReviewing>

      <AssignmentTabs
        assignmentId={assignment.id}
        needsReviewCount={header.counts.needs_review}
        keyNeedsAttention={!header.keyApproved && header.keyStatus !== "processing"}
      />

      {children}
    </>
  );
}
