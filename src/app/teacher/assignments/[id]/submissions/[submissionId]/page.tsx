import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReviewPanel } from "@/components/teacher/review-panel";
import { requireOwnedSubmission } from "@/lib/auth/dal";
import { now } from "@/lib/clock";
import { getPublicOrigin } from "@/lib/http/request";
import { getReviewView } from "@/lib/services/views";

const GRADING_POLL_MS = 3000;

export default async function ReviewPage(props: PageProps<"/teacher/assignments/[id]/submissions/[submissionId]">) {
  await connection();
  const { id, submissionId } = await props.params;
  const { assignment, submission } = await requireOwnedSubmission(submissionId);
  // The paper must belong to the assignment in the URL, or the tabs and navigation would mix two assignments.
  if (submission.assignmentId !== id) notFound();
  const view = getReviewView(submission, assignment, getPublicOrigin(await headers()));
  const grading = submission.status === "queued" || submission.status === "grading";

  return (
    <>
      <ReviewPanel key={submission.id} assignmentId={assignment.id} view={view} serverNow={now()} />
      <AutoRefresh intervalMs={grading ? GRADING_POLL_MS : null} />
    </>
  );
}
