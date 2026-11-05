import type { Tone } from "@/components/ui/tone";
import { kindNoun } from "@/lib/format";
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
 * The one line an assignment card shows: what the teacher should do next, most urgent first, or where things stand
 * once nothing is waiting for them (papers being graded, or everything checked).
 */
export function nextStep(a: DashboardAssignment): NextStep {
  const keyHref = `/teacher/assignments/${a.id}/key`;
  if (a.kind === "project" && !a.keyApproved) {
    if (a.keyStatus === "processing") return { text: "Reading your rubric…", href: keyHref, tone: "info" };
    if (a.keyStatus === "failed") return { text: "The rubric couldn't be read — open it to try again", href: keyHref, tone: "danger" };
    if (a.keyStatus === "ready") return { text: "Next: check and approve the rubric", href: keyHref, tone: "warning" };
    return { text: "Next: say how to grade the project", href: keyHref, tone: "info" };
  }
  // A project ready for papers may have no key at all (instructions only).
  if (a.kind !== "project") switch (a.keyStatus) {
    case "empty":
      return { text: "Next: add the answer key", href: keyHref, tone: "info" };
    case "processing":
      return { text: "Reading your answer key…", href: keyHref, tone: "info" };
    case "failed":
      return { text: "The answer key couldn't be read — open it to try again", href: keyHref, tone: "danger" };
    case "ready":
      break;
  }
  if (!a.keyApproved) return { text: "Next: check and approve the answer key", href: keyHref, tone: "warning" };
  if (a.counts.needs_review > 0) {
    const n = a.counts.needs_review;
    return { text: `Next: check ${plural(n, "paper")} the AI flagged`, href: boardHref(a.id, "needs_review"), tone: "warning" };
  }
  if (a.counts.failed > 0) {
    const n = a.counts.failed;
    return { text: `${plural(n, "paper")} couldn't be graded — retry or grade by hand`, href: boardHref(a.id, "failed"), tone: "danger" };
  }
  const scanStep = pendingScanStep(a);
  if (scanStep) return scanStep;
  if (a.counts.total === 0) {
    return { text: `Next: upload the students' ${kindNoun(a.kind, true)}`, href: uploadHref(a.id), tone: "info" };
  }
  if (a.counts.queued + a.counts.grading > 0) return { text: "Grading papers…", href: boardHref(a.id, "all"), tone: "info" };
  return { text: "All papers graded and checked — see the results", href: boardHref(a.id, "all"), tone: "success" };
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
      text: review === 1 ? "Next: check how your scan was split" : `Next: check how ${review} scans were split`,
      href: review === 1 && firstReviewId ? `/teacher/assignments/${a.id}/scans/${firstReviewId}` : uploadHref(a.id),
      tone: "warning",
    };
  }
  if (failed > 0) {
    return { text: failed === 1 ? "A scan couldn't be split" : `${failed} scans couldn't be split`, href: uploadHref(a.id), tone: "danger" };
  }
  if (splitting > 0 && a.counts.total === 0) {
    const text = a.scans.onePass === splitting ? "Grading your scan…" : "Finding each student's paper in your scan…";
    return { text, href: uploadHref(a.id), tone: "info" };
  }
  return null;
}
