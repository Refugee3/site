import type { Metadata } from "next";
import Link from "next/link";
import { assignmentSteps } from "@/components/teacher/assignment-steps";
import { AssignmentStepsGuide } from "@/components/teacher/assignment-steps-guide";
import { AssignmentTabs } from "@/components/teacher/assignment-tabs";
import { EditableTitle } from "@/components/teacher/editable-title";
import { HiddenWhileReviewing } from "@/components/teacher/hidden-while-reviewing";
import { plural } from "@/components/teacher/text";
import { Badge } from "@/components/ui/badge";
import { ArrowLeftIcon, BookIcon, QuizIcon } from "@/components/ui/icons";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { formatPoints, KIND_LABEL } from "@/lib/format";
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
      <div className="flex flex-col gap-3">
        <Link href="/teacher" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted no-underline hover:text-brand-700">
          <ArrowLeftIcon className="size-4" /> All assignments
        </Link>
        <div className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgb(20_23_51/0.04),0_8px_24px_-12px_rgb(20_23_51/0.12)] sm:p-6">
          <div aria-hidden="true" className={assignment.kind === "quiz"
            ? "absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-brand-500 to-brand-700"
            : "absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-gold-300 to-gold-500"} />
          <div className="flex flex-wrap items-start gap-4">
            <span className={assignment.kind === "quiz"
              ? "grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700"
              : "grid size-12 shrink-0 place-items-center rounded-2xl bg-gold-50 text-gold-800"}>
              {assignment.kind === "quiz" ? <QuizIcon className="size-6" /> : <BookIcon className="size-6" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <EditableTitle
                  assignmentId={assignment.id}
                  title={assignment.title}
                  placeholder={isPlaceholderTitle(assignment.title)}
                  note={isPlaceholderTitle(assignment.title) && header.keyStatus === "processing" ? "The AI names it once it has read the key." : null}
                />
                <Badge tone={assignment.kind === "quiz" ? "info" : "neutral"}>{KIND_LABEL[assignment.kind]}</Badge>
              </div>
              <ul className="flex flex-wrap items-center gap-2 text-sm">
                {header.itemCount > 0 && (
                  <li className="rounded-lg bg-subtle px-2.5 py-1 text-ink">
                    {plural(header.itemCount, "question")} · {formatPoints(header.totalPointsCenti)} points
                  </li>
                )}
                <li className="rounded-lg bg-subtle px-2.5 py-1 text-ink">{plural(header.counts.total, "paper")}</li>
                {header.counts.needs_review > 0 && (
                  <li className="rounded-lg bg-warning-50 px-2.5 py-1 font-medium text-warning-800">{header.counts.needs_review} to check</li>
                )}
                {!assignment.writeNotes && (
                  <li>
                    <Link
                      href={`/teacher/assignments/${assignment.id}/settings`}
                      title="The AI doesn't write feedback notes. Change it in Settings."
                      className="rounded-lg bg-subtle px-2.5 py-1 text-muted"
                    >
                      Feedback notes off
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
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
