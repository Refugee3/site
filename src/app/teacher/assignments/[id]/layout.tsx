import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { AssignmentTabs } from "@/components/teacher/assignment-tabs";
import { CollapsedOnPhones } from "@/components/teacher/collapsed-on-phones";
import { HiddenWhileReviewing } from "@/components/teacher/hidden-while-reviewing";
import { LifecycleButtons } from "@/components/teacher/lifecycle-buttons";
import { ShareCard } from "@/components/teacher/share-card";
import { plural } from "@/components/teacher/text";
import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import type { Tone } from "@/components/ui/tone";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { formatPoints, formatShareCode, KIND_LABEL } from "@/lib/format";
import { getPublicOrigin } from "@/lib/http/request";
import { getAssignmentHeader } from "@/lib/services/views";
import type { AssignmentHeader } from "@/lib/types";

type Props = LayoutProps<"/teacher/assignments/[id]">;

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { assignment } = await requireOwnedAssignment((await params).id);
  return { title: assignment.title };
}

// Not an auth boundary: each page below checks ownership again through the DAL.
export default async function AssignmentLayout({ params, children }: Props) {
  const { id } = await params;
  const { assignment } = await requireOwnedAssignment(id);
  const header = getAssignmentHeader(assignment, getPublicOrigin(await headers()));
  const keyState = describeKey(header);
  const feedbackReleased = assignment.feedbackReleasedAt !== null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/teacher" className="self-start text-sm">
          ← All assignments
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{assignment.title}</h1>
          <Badge tone={assignment.kind === "quiz" ? "info" : "neutral"}>{KIND_LABEL[assignment.kind]}</Badge>
          {/* While uploads are off, "Open" still shows: the assignment takes uploads again once they are on. */}
          {(header.studentsCanUpload || assignment.status === "open") && <StatusBadge status={assignment.status} />}
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span>Answer key:</span>
          <Badge tone={keyState.tone}>{keyState.label}</Badge>
          {header.itemCount > 0 && (
            <span>
              {plural(header.itemCount, "item")} · {formatPoints(header.totalPointsCenti)} pts
            </span>
          )}
          <span aria-hidden="true">·</span>
          <span>{plural(header.counts.total, "paper")}</span>
        </p>
      </div>

      <HiddenWhileReviewing>
        <CollapsedOnPhones
          summary={
            <>
              {header.studentsCanUpload && (
                <>
                  Code <span className="font-mono font-semibold tracking-wider">{formatShareCode(assignment.shareCode)}</span>
                  {" · "}
                </>
              )}
              {feedbackReleased ? "Feedback released" : "Feedback hidden"}
            </>
          }
          className={cx("grid gap-4", header.studentsCanUpload ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "lg:grid-cols-2")}
        >
          {header.studentsCanUpload && (
            <ShareCard shareUrl={header.shareUrl} shareCode={assignment.shareCode} status={assignment.status} />
          )}
          <LifecycleButtons
            assignmentId={assignment.id}
            status={assignment.status}
            canOpen={header.canOpen}
            keyApproved={header.keyApproved}
            released={feedbackReleased}
            needsReviewCount={header.counts.needs_review}
            studentsCanUpload={header.studentsCanUpload}
          />
        </CollapsedOnPhones>
      </HiddenWhileReviewing>

      <AssignmentTabs
        assignmentId={assignment.id}
        needsReviewCount={header.counts.needs_review}
        keyNeedsAttention={!header.keyApproved && header.keyStatus !== "processing"}
        studentsCanUpload={header.studentsCanUpload}
        kind={assignment.kind}
      />

      {children}
    </>
  );
}

function describeKey(header: AssignmentHeader): { label: string; tone: Tone } {
  if (header.keyApproved) return { label: "Approved", tone: "success" };
  switch (header.keyStatus) {
    case "empty":
      return { label: "Not added yet", tone: "neutral" };
    case "processing":
      return { label: "Being read…", tone: "info" };
    case "failed":
      return { label: "Couldn't be read", tone: "danger" };
    case "ready":
      return { label: "Waiting for your check", tone: "warning" };
  }
}
