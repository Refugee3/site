import type { AssignmentHeader, AssignmentKind } from "@/lib/types";
import { plural } from "./text";

export type StepState = "done" | "current" | "todo";

export interface AssignmentStep {
  number: 1 | 2 | 3;
  title: string;
  /** One short line on where the step stands. */
  status: string;
  href: string;
  state: StepState;
}

/**
 * The assignment page's guide: 1. Add the answer key → 2. Upload students' work → 3. Review results. A step is done
 * once its job is (an approved key; at least one paper; every paper graded and checked); the first step not done is
 * the current one, and the ones after it wait.
 */
export function assignmentSteps(
  h: Pick<AssignmentHeader, "keyStatus" | "keyApproved" | "counts" | "scans">, assignmentId: string, kind: AssignmentKind = "homework",
): AssignmentStep[] {
  const project = kind === "project";
  const base = `/teacher/assignments/${assignmentId}`;
  const { counts, scans } = h;
  const inProgress = counts.queued + counts.grading;
  const scansWaiting = scans.review + scans.failed + scans.splitting;

  const keyDone = h.keyApproved;
  const uploadDone = counts.total > 0;
  const reviewDone = uploadDone && inProgress === 0 && counts.needs_review === 0 && counts.failed === 0 && scansWaiting === 0;

  const steps: Array<Omit<AssignmentStep, "state"> & { done: boolean }> = [
    {
      number: 1, title: project ? "Say how to grade it" : "Add the answer key", status: project ? projectStatusText(h) : keyStatusText(h),
      href: `${base}/key`, done: keyDone,
    },
    {
      number: 2,
      title: "Upload students' work",
      status: uploadDone ? `${plural(counts.total, "paper")} uploaded` : scans.splitting > 0 ? "Reading your scan…" : "No papers yet",
      href: `${base}/upload`,
      done: uploadDone,
    },
    { number: 3, title: "Review results", status: reviewStatusText(h, uploadDone, inProgress), href: base, done: reviewDone },
  ];
  const current = steps.findIndex((step) => !step.done);
  return steps.map(({ done, ...step }, i) => ({ ...step, state: done ? "done" : i === current ? "current" : "todo" }));
}

function projectStatusText(h: Pick<AssignmentHeader, "keyStatus" | "keyApproved">): string {
  if (h.keyApproved) return "Ready";
  if (h.keyStatus === "processing") return "Reading your rubric…";
  if (h.keyStatus === "ready") return "Check and approve the rubric";
  if (h.keyStatus === "failed") return "The rubric couldn't be read";
  return "Write the instructions";
}

function keyStatusText(h: Pick<AssignmentHeader, "keyStatus" | "keyApproved">): string {
  if (h.keyApproved) return "Approved";
  switch (h.keyStatus) {
    case "empty":
      return "Not added yet";
    case "processing":
      return "Being read…";
    case "failed":
      return "Couldn't be read";
    case "ready":
      return "Check and approve it";
  }
}

function reviewStatusText(h: Pick<AssignmentHeader, "counts" | "scans">, uploadDone: boolean, inProgress: number): string {
  const { counts, scans } = h;
  if (counts.needs_review > 0) return `${counts.needs_review} need${counts.needs_review === 1 ? "s" : ""} your check`;
  if (counts.failed > 0) return `${counts.failed} couldn't be graded`;
  if (scans.review > 0) return "Check your scan's split";
  if (inProgress > 0) return `Grading ${plural(inProgress, "paper")}…`;
  if (!uploadDone) return "Nothing to review yet";
  return "All graded and checked";
}
