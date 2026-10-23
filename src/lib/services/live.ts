import { now } from "@/lib/clock";
import { listSections } from "@/lib/db/repos/assignments";
import { keyQuestionsStamp, listKeyQuestions } from "@/lib/db/repos/key-questions";
import { listScans } from "@/lib/db/repos/scans";
import { listItemsForAssignment, listSubmissions } from "@/lib/db/repos/submissions";
import { one } from "@/lib/db/sql";
import { countCurrent, organizeBoard } from "@/lib/grading/board";
import { computeItemStats } from "@/lib/grading/item-stats";
import { getWorkerStatus } from "@/lib/jobs/queue";
import {
  buildAssignmentLiveSnapshot, buildDashboardLiveSnapshot, type AssignmentLiveSnapshot, type DashboardLiveSnapshot,
} from "@/lib/live/snapshot";
import { isKeyLocked, loadKeyState } from "@/lib/services/key-state";
import { getGradingProgress, getSplitProgress, typicalExtractionMs } from "@/lib/services/progress";
import { getDashboardView } from "@/lib/services/views";
import type { Assignment, Teacher } from "@/lib/types";

// What the live routes push (see lib/live/snapshot.ts): loading is a handful of queries, and a cheap stamp says when it is
// worth loading again.

export function loadAssignmentLive(a: Assignment): AssignmentLiveSnapshot {
  const { key, items, approved } = loadKeyState(a.id);
  const submissions = listSubmissions(a.id);
  const sections = listSections(a.id);
  const board = organizeBoard(submissions, sections);
  const worker = getWorkerStatus();
  return buildAssignmentLiveSnapshot({
    now: now(),
    assignment: a,
    key,
    items,
    approved,
    locked: isKeyLocked(a.id),
    typicalExtractionMs: typicalExtractionMs(),
    questions: listKeyQuestions(a.id),
    board,
    counts: countCurrent(board),
    progress: getGradingProgress(a.id),
    worker,
    highlighted: computeItemStats(items, submissions, sections, listItemsForAssignment(a.id), a).highlighted,
    scans: listScans(a.id).map((scan) => ({ scan, progress: getSplitProgress(scan) })),
  });
}

/**
 * Changes whenever anything the assignment's snapshot shows may have changed: its row, key, questions, papers (any status
 * change, score or edit), scans (pages read, papers made) and the worker's state. One query; no snapshot is built.
 */
export function assignmentLiveStamp(assignmentId: string): string {
  const row = one<Record<string, number | string | null>>(
    `SELECT
       (SELECT title || ':' || updated_at FROM assignments WHERE id = @id) AS a,
       (SELECT status || ':' || updated_at FROM answer_keys WHERE assignment_id = @id) AS k,
       (SELECT count(*) || ':' || coalesce(max(updated_at), 0) || ':' || coalesce(sum(score_earned_centi), 0) || ':'
               || coalesce(sum(status = 'graded'), 0) || ':' || coalesce(sum(status = 'needs_review'), 0) || ':'
               || coalesce(sum(status = 'queued'), 0) || ':' || coalesce(sum(status = 'grading'), 0)
          FROM submissions WHERE assignment_id = @id) AS s,
       (SELECT count(*) || ':' || coalesce(max(updated_at), 0) || ':' || coalesce(sum(pages_read), 0) || ':'
               || coalesce(sum(coalesce(created_count, 0)), 0)
          FROM scans WHERE assignment_id = @id) AS c`,
    { id: assignmentId },
  );
  return [row?.a, row?.k, row?.s, row?.c, keyQuestionsStamp(assignmentId), workerStamp()].join("|");
}

/** The dashboard's cards for the teacher, in short. */
export function loadDashboardLive(t: Teacher): DashboardLiveSnapshot {
  return buildDashboardLiveSnapshot(getDashboardView(t), now());
}

/** As assignmentLiveStamp, over every assignment of the teacher (what the dashboard's cards show). */
export function dashboardLiveStamp(teacherId: string): string {
  const row = one<Record<string, number | string | null>>(
    `SELECT
       (SELECT count(*) || ':' || coalesce(max(updated_at), 0) FROM assignments WHERE teacher_id = @t) AS a,
       (SELECT coalesce(max(k.updated_at), 0) FROM answer_keys k JOIN assignments a ON a.id = k.assignment_id WHERE a.teacher_id = @t) AS k,
       (SELECT count(*) || ':' || coalesce(max(s.updated_at), 0) || ':' || coalesce(sum(s.status IN ('queued', 'grading')), 0)
          FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE a.teacher_id = @t) AS s,
       (SELECT count(*) || ':' || coalesce(max(c.updated_at), 0)
          FROM scans c JOIN assignments a ON a.id = c.assignment_id WHERE a.teacher_id = @t) AS c`,
    { t: teacherId },
  );
  return [row?.a, row?.k, row?.s, row?.c].join("|");
}

function workerStamp(): string {
  const w = getWorkerStatus();
  return w ? `${w.state}:${w.throttledUntil ?? 0}` : "none";
}
