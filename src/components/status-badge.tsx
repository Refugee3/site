import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/tone";
import { STATUS_LABEL } from "@/lib/format";
import type { SubmissionStatus } from "@/lib/types";

const TONES: Record<SubmissionStatus, Tone> = {
  queued: "info",
  grading: "info",
  graded: "success",
  needs_review: "warning",
  failed: "danger",
};

/** A paper's status pill, which always carries its text (color is never the only signal). */
export function StatusBadge({ status }: { status: SubmissionStatus }) {
  return <Badge tone={TONES[status]}>{STATUS_LABEL[status]}</Badge>;
}
