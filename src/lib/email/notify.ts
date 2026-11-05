import "server-only";
import { now } from "@/lib/clock";
import { getAssignment, listSections } from "@/lib/db/repos/assignments";
import {
  getNotifyByEmail, getNotifyState, listAssignmentIds, recordEmailError, recordEmailSent, setGradingNotifiedAt, setKeyNotifiedRevision,
} from "@/lib/db/repos/email";
import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import { countPendingScans } from "@/lib/db/repos/scans";
import { listSubmissions } from "@/lib/db/repos/submissions";
import { getTeacher } from "@/lib/db/repos/teachers";
import { organizeBoard } from "@/lib/grading/board";
import { percentTenths } from "@/lib/grading/scoring";
import { type EmailContent, gradingDoneEmail, keyReadyEmail } from "./messages";
import { currentSmtpConfig, publicBaseUrl } from "./settings";
import { sendEmail } from "./smtp";

// Emails the teacher when their work is done, so they can close the tab: "Graded: Unit 4 Quiz" once an assignment's papers
// are all graded (no paper queued or grading, no scan being split), and "Answer key ready to check" once the AI has read a key
// that isn't approved yet. The worker asks for a check whenever a job ends (scheduleNotificationCheck); the check runs a
// minute later, so a class uploaded in parts or a key approved right away doesn't email. What was emailed is stored with the
// assignment (grading_notified_at, key_notified_revision), so a restart (sweepNotifications) never emails twice.

/** How long after the last job ends the check runs. */
export const NOTIFY_DELAY_MS = 60_000;

interface NotifySlots {
  timers: Map<string, NodeJS.Timeout>;
  checking: Set<string>;
}

const SLOT = Symbol.for("pag.email-notify");
const slots = globalThis as unknown as Record<symbol, NotifySlots | undefined>;

function state(): NotifySlots {
  return (slots[SLOT] ??= { timers: new Map(), checking: new Set() });
}

/** Checks the assignment `delayMs` from now (a later call for it moves the check later). */
export function scheduleNotificationCheck(assignmentId: string, delayMs = NOTIFY_DELAY_MS): void {
  const { timers } = state();
  const pending = timers.get(assignmentId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    timers.delete(assignmentId);
    void checkAssignmentNotifications(assignmentId).catch((e: unknown) => console.error(`[email] check of ${assignmentId} failed`, e));
  }, delayMs);
  timer.unref();
  timers.set(assignmentId, timer);
}

/** After a restart: every assignment, in case its work finished while the server was down or before the timer fired. */
export function sweepNotifications(delayMs = NOTIFY_DELAY_MS): void {
  const timer = setTimeout(() => {
    for (const id of listAssignmentIds()) scheduleNotificationCheck(id, 0);
  }, delayMs);
  timer.unref();
}

/** Sends what is due for the assignment now, if email is set up and its teacher wants it. Never throws for a failed send. */
export async function checkAssignmentNotifications(assignmentId: string): Promise<void> {
  const { checking } = state();
  if (checking.has(assignmentId)) return;
  checking.add(assignmentId);
  try {
    const due = dueEmails(assignmentId);
    if (due.length === 0) return;
    const smtp = currentSmtpConfig();
    for (const email of due) {
      // Recorded first: a failed send isn't retried every minute (the error shows in Settings).
      email.markSent();
      if (!smtp || !email.to) continue;
      try {
        await sendEmail(smtp, { to: email.to, ...email.content });
        recordEmailSent(now());
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        recordEmailError(message, now());
        console.error(`[email] couldn't send "${email.content.subject}": ${message}`);
      }
    }
  } finally {
    checking.delete(assignmentId);
  }
}

interface DueEmail {
  /** The teacher's address; null when they turned emails off (what's due is still marked as handled). */
  to: string | null;
  content: EmailContent;
  markSent: () => void;
}

/** What should be emailed about the assignment now (exported for tests). */
export function dueEmails(assignmentId: string): DueEmail[] {
  const assignment = getAssignment(assignmentId);
  const notify = getNotifyState(assignmentId);
  if (!assignment || !notify) return [];
  const teacher = getTeacher(assignment.teacherId);
  const to = teacher && getNotifyByEmail(teacher.id) ? teacher.email : null;
  const base = publicBaseUrl();
  const page = (path: string) => (base ? `${base}/teacher/assignments/${assignment.id}${path}` : null);
  const due: DueEmail[] = [];

  const key = getKey(assignmentId);
  if (key && key.status === "ready" && key.approvedRevision !== key.revision && key.revision > (notify.keyNotifiedRevision ?? -1)) {
    due.push({
      to,
      content: keyReadyEmail({ title: assignment.title, questions: listKeyItems(assignmentId).length, keyUrl: page("/key") }),
      markSent: () => setKeyNotifiedRevision(assignmentId, key.revision),
    });
  }

  const submissions = listSubmissions(assignmentId);
  const busy = submissions.some((s) => s.status === "queued" || s.status === "grading") || countPendingScans(assignmentId).splitting > 0;
  if (busy) return due;
  const since = notify.gradingNotifiedAt ?? 0;
  const newlyGraded = submissions.filter((s) => (s.status === "graded" || s.status === "needs_review") && (s.gradedAt ?? 0) > since);
  const newlyFailed = submissions.filter((s) => s.status === "failed" && s.queuedAt > since);
  if (newlyGraded.length === 0 && newlyFailed.length === 0) return due;

  const current = organizeBoard(submissions, listSections(assignmentId)).flatMap((group) => group.rows.map((row) => row.current));
  const percents = current
    .filter((s) => (s.status === "graded" || s.status === "needs_review") && s.scoreEarnedCenti !== null && (s.scoreMaxCenti ?? 0) > 0)
    .map((s) => percentTenths(s.scoreEarnedCenti!, s.scoreMaxCenti!))
    .filter((p): p is number => p !== null);
  const toCheck = current.filter((s) => s.status === "needs_review").length;
  const latest = Math.max(since, ...newlyGraded.map((s) => s.gradedAt ?? 0), ...newlyFailed.map((s) => s.queuedAt));
  due.push({
    to,
    content: gradingDoneEmail({
      title: assignment.title,
      graded: newlyGraded.length,
      toCheck,
      failed: current.filter((s) => s.status === "failed").length,
      averageTenths: percents.length > 0 ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null,
      resultsUrl: page(""),
      checkUrl: toCheck > 0 ? page("?filter=needs_review") : null,
    }),
    markSent: () => setGradingNotifiedAt(assignmentId, latest),
  });
  return due;
}
