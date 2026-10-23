import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";

/** Shown inside the teacher shell for an assignment or paper that doesn't exist or isn't this teacher's. */
export default function TeacherNotFound() {
  return (
    <EmptyState
      title="Not found"
      body="This assignment or paper doesn't exist, or it was deleted."
      action={<LinkButton href="/teacher">Back to assignments</LinkButton>}
    />
  );
}
