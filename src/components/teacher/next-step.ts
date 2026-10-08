import type { Tone } from "@/components/ui/tone";
import { uploadLabel } from "@/lib/format";
import type { DashboardView } from "@/lib/types";
import { boardHref } from "./board-helpers";
import { plural } from "./text";

export interface NextStep {
  text: string;
  href: string;
  tone: Tone;
}

type DashboardAssignment = DashboardView["assignments"][number];

/**
 * The one thing an assignment card asks the teacher to do next, most urgent first; null when nothing is pending.
 * While students can't upload, the teacher uploads the papers, and there is nothing to open or remind about.
 */
export function nextStep(a: DashboardAssignment, o: { studentsCanUpload: boolean }): NextStep | null {
  const keyHref = `/teacher/assignments/${a.id}/key`;
  switch (a.keyStatus) {
    case "empty":
      return { text: "Add the answer key", href: keyHref, tone: "info" };
    case "processing":
      return { text: "Reading the answer key…", href: keyHref, tone: "info" };
    case "failed":
      return { text: "The answer key couldn't be read", href: keyHref, tone: "danger" };
    case "ready":
      break;
  }
  if (!a.keyApproved) return { text: "Check and approve the answer key", href: keyHref, tone: "warning" };
  if (a.counts.needs_review > 0) {
    return { text: `${plural(a.counts.needs_review, "paper")} to review`, href: boardHref(a.id, "needs_review"), tone: "warning" };
  }
  if (a.counts.failed > 0) {
    return { text: `${plural(a.counts.failed, "paper")} failed to grade`, href: boardHref(a.id, "failed"), tone: "danger" };
  }
  const scanStep = pendingScanStep(a);
  if (scanStep) return scanStep;
  if (!o.studentsCanUpload) {
    return a.counts.total === 0 ? { text: uploadLabel(a.kind), href: uploadHref(a.id), tone: "info" } : null;
  }
  if (a.status === "draft") return { text: "Open it for students", href: boardHref(a.id, "all"), tone: "info" };
  // Everything is graded and checked, but students still see only "received": the switch is on the assignment page.
  const inProgress = a.counts.queued + a.counts.grading;
  if (!a.released && a.counts.graded > 0 && inProgress === 0) {
    return { text: `Release feedback on ${plural(a.counts.graded, "graded paper")}`, href: boardHref(a.id, "all"), tone: "info" };
  }
  return null;
}

function uploadHref(assignmentId: string): string {
  return `/teacher/assignments/${assignmentId}/upload`;
}

/**
 * A scan of the class's papers waiting for the teacher: no paper is made from it until they check its split. One
 * that failed to split needs them too. One still being split is mentioned only while there are no papers to show.
 */
function pendingScanStep(a: DashboardAssignment): NextStep | null {
  const { review, failed, splitting, firstReviewId } = a.scans;
  if (review > 0) {
    return {
      text: review === 1 ? "Check the split of your scan" : `Check the split of ${review} scans`,
      href: review === 1 && firstReviewId ? `/teacher/assignments/${a.id}/scans/${firstReviewId}` : uploadHref(a.id),
      tone: "warning",
    };
  }
  if (failed > 0) {
    return { text: failed === 1 ? "A scan couldn't be split" : `${failed} scans couldn't be split`, href: uploadHref(a.id), tone: "danger" };
  }
  if (splitting > 0 && a.counts.total === 0) return { text: "Splitting your scan…", href: uploadHref(a.id), tone: "info" };
  return null;
}
