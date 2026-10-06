import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/tone";
import { STATUS_LABEL } from "@/lib/format";
import type { AssignmentStatus, KeyStatus, SubmissionStatus } from "@/lib/types";

type AnyStatus = SubmissionStatus | AssignmentStatus | KeyStatus;

// "failed" is both a submission and a key status; it reads the same for both. Key labels are kept neutral
// ("Ready", not "Key ready") because callers put them next to their own "Answer key" label.
const STATUSES: Record<AnyStatus, { label: string; tone: Tone }> = {
  queued: { label: STATUS_LABEL.queued, tone: "info" },
  grading: { label: STATUS_LABEL.grading, tone: "info" },
  graded: { label: STATUS_LABEL.graded, tone: "success" },
  needs_review: { label: STATUS_LABEL.needs_review, tone: "warning" },
  failed: { label: STATUS_LABEL.failed, tone: "danger" },
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Open", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
  empty: { label: "Empty", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  ready: { label: "Ready", tone: "success" },
};

/** A status pill that always carries its text (color is never the only signal). */
export function StatusBadge({ status }: { status: AnyStatus }) {
  const { label, tone } = STATUSES[status];
  return <Badge tone={tone}>{label}</Badge>;
}
