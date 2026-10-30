import type { BoardGroup } from "@/lib/grading/board";
import { percentTenths } from "@/lib/grading/scoring";
import type {
  AnswerKey, Assignment, AssignmentKind, DashboardView, GradingProgress, KeyItem, KeyQuestion, KeyQuestionKind, KeyQuestionStatus, KeyStatus,
  Scan, ScanSplitMode, ScanSplitProgress, ScanStatus, StatusCounts, SubmissionStatus, WorkerStatus,
} from "@/lib/types";

// The compact JSON the live (Server-Sent Events) routes push to an open workspace or dashboard. Built from rows already loaded,
// so it is pure and cheap to compare: a snapshot is sent only when its signature changes. Never anything but what the teacher's
// own pages show; no AI calls.

/** How many finished papers the workspace's feed shows. */
export const LIVE_RECENT_PAPERS = 8;
/** How many "most missed" questions the snapshot carries. */
export const LIVE_STRUGGLING = 5;

export interface LiveKeyQuestion {
  id: string;
  kind: KeyQuestionKind;
  itemLabel: string | null;
  question: string;
  suggestedAnswer: string | null;
  choices: string[];
  status: KeyQuestionStatus;
  answer: string | null;
}

export interface LiveKey {
  status: KeyStatus;
  approved: boolean;
  /** The key's updatedAt: approving from the workspace names the version the teacher saw. */
  updatedAt: number;
  itemCount: number;
  totalPointsCenti: number;
  /** Items whose answer the AI proposed (approving them needs the teacher's acknowledgement). */
  aiProposedCount: number;
  /** Items the AI read with low or medium confidence. */
  uncertainCount: number;
  pageCount: number | null;
  filename: string | null;
  errorMessage: string | null;
  aiNotes: string;
  /** The teacher's grading instructions (shown in the "Instructions for the AI" box when uploading the key again). */
  instructions: string;
  /** Papers were graded with this key, so it can't be replaced or read again. */
  locked: boolean;
  /** While the AI reads the key: since when, and how long a reading usually takes. */
  extraction: { startedAt: number; typicalMs: number } | null;
}

export interface LivePaper {
  submissionId: string;
  name: string;
  /** The board section it is grouped under. */
  section: string;
  status: SubmissionStatus;
  scoreEarnedCenti: number | null;
  scoreMaxCenti: number | null;
  percentTenths: number | null;
  /** When it finished (graded, flagged or failed). */
  finishedAt: number;
}

export interface LiveScan {
  id: string;
  status: ScanStatus;
  splitMode: ScanSplitMode;
  filename: string;
  pageCount: number;
  /** Papers made from it so far (graded in one pass) or in all. */
  papers: number | null;
  progress: ScanSplitProgress | null;
  errorMessage: string | null;
}

export interface LiveStruggling {
  itemId: string;
  label: string;
  prompt: string;
  missedTenths: number;
  missedPapers: number;
  judged: number;
}

export interface AssignmentLiveSnapshot {
  /** When the server built it (epoch ms): timers count from here. */
  serverNow: number;
  assignment: { id: string; title: string; kind: AssignmentKind };
  key: LiveKey;
  questions: LiveKeyQuestion[];
  /** Current papers by status (as on the board). */
  counts: StatusCounts;
  progress: GradingProgress | null;
  worker: { halted: boolean; throttledUntil: number | null };
  /** The latest finished papers, newest first. */
  recentPapers: LivePaper[];
  struggling: LiveStruggling[];
  /** Scans still being read, waiting for the teacher's check, or failed. */
  scans: LiveScan[];
}

export interface AssignmentLiveInput {
  now: number;
  assignment: Pick<Assignment, "id" | "title" | "kind">;
  key: AnswerKey;
  items: readonly KeyItem[];
  approved: boolean;
  locked: boolean;
  typicalExtractionMs: number;
  questions: readonly KeyQuestion[];
  /** organizeBoard(listSubmissions, listSections): current papers by section. */
  board: readonly BoardGroup[];
  counts: StatusCounts;
  progress: GradingProgress | null;
  /** null when no worker runs in this process. */
  worker: WorkerStatus | null;
  /** computeItemStats(…).highlighted. */
  highlighted: ReadonlyArray<{ item: Pick<KeyItem, "id" | "label" | "prompt">; missedTenths: number | null; missedPapers: number; judged: number }>;
  scans: ReadonlyArray<{ scan: Scan; progress: ScanSplitProgress | null }>;
}

const FINISHED: ReadonlySet<SubmissionStatus> = new Set(["graded", "needs_review", "failed"]);
const PENDING_SCAN: ReadonlySet<ScanStatus> = new Set(["splitting", "review", "failed"]);
const UNNAMED = "No name";

export function buildAssignmentLiveSnapshot(i: AssignmentLiveInput): AssignmentLiveSnapshot {
  const { key, items } = i;
  return {
    serverNow: i.now,
    assignment: { id: i.assignment.id, title: i.assignment.title, kind: i.assignment.kind },
    key: {
      status: key.status,
      approved: i.approved,
      updatedAt: key.updatedAt,
      itemCount: items.length,
      totalPointsCenti: items.reduce((sum, item) => sum + item.pointsCenti, 0),
      aiProposedCount: items.filter((item) => item.answerSource === "ai_proposed").length,
      uncertainCount: items.filter((item) => item.aiConfidence === "low" || item.aiConfidence === "medium").length,
      pageCount: key.sourcePageCount,
      filename: key.sourceFilename,
      errorMessage: key.status === "failed" ? key.errorMessage : null,
      aiNotes: key.aiNotes,
      instructions: key.teacherNotes,
      locked: i.locked,
      extraction: key.status === "processing"
        ? { startedAt: key.processingStartedAt ?? key.updatedAt, typicalMs: i.typicalExtractionMs }
        : null,
    },
    questions: i.questions.map((q) => ({
      id: q.id, kind: q.kind, itemLabel: q.itemLabel, question: q.question, suggestedAnswer: q.suggestedAnswer, choices: q.choices,
      status: q.status, answer: q.answer,
    })),
    counts: i.counts,
    progress: i.progress,
    worker: {
      halted: i.worker === null || i.worker.state !== "running",
      throttledUntil: i.worker?.throttledUntil ?? null,
    },
    recentPapers: recentPapers(i.board),
    struggling: i.highlighted.slice(0, LIVE_STRUGGLING).map((s) => ({
      itemId: s.item.id, label: s.item.label, prompt: s.item.prompt, missedTenths: s.missedTenths ?? 0, missedPapers: s.missedPapers,
      judged: s.judged,
    })),
    scans: i.scans
      .filter(({ scan }) => PENDING_SCAN.has(scan.status))
      .map(({ scan, progress }) => ({
        id: scan.id,
        status: scan.status,
        splitMode: scan.splitMode,
        filename: scan.originalFilename,
        pageCount: scan.pageCount,
        papers: scan.splitMode === "one_pass" ? (progress?.papersGraded ?? scan.createdCount) : scan.createdCount,
        progress,
        errorMessage: scan.status === "failed" ? scan.errorMessage : null,
      })),
  };
}

/** The current papers that finished, newest first (ties: board order), at most LIVE_RECENT_PAPERS. */
function recentPapers(board: readonly BoardGroup[]): LivePaper[] {
  const finished = board.flatMap((group) => group.rows
    .map((row) => row.current)
    .filter((s) => FINISHED.has(s.status))
    .map((s): LivePaper => {
      const graded = s.status !== "failed" && s.scoreEarnedCenti !== null && s.scoreMaxCenti !== null;
      return {
        submissionId: s.id,
        name: s.studentName ?? UNNAMED,
        section: group.label,
        status: s.status,
        scoreEarnedCenti: graded ? s.scoreEarnedCenti : null,
        scoreMaxCenti: graded ? s.scoreMaxCenti : null,
        percentTenths: graded && s.scoreEarnedCenti !== null && s.scoreMaxCenti !== null ? percentTenths(s.scoreEarnedCenti, s.scoreMaxCenti) : null,
        finishedAt: s.gradedAt ?? s.updatedAt,
      };
    }));
  return finished
    .map((paper, order) => ({ paper, order }))
    .sort((a, b) => b.paper.finishedAt - a.paper.finishedAt || a.order - b.order)
    .slice(0, LIVE_RECENT_PAPERS)
    .map(({ paper }) => paper);
}

/**
 * What decides whether a snapshot is new: everything but the moment it was built and the estimates that only shrink with time
 * (the page counts those down itself).
 */
export function assignmentLiveSignature(s: AssignmentLiveSnapshot): string {
  return JSON.stringify({
    ...s,
    serverNow: 0,
    progress: s.progress && { ...s.progress, etaMs: 0 },
    scans: s.scans.map((scan) => ({ ...scan, progress: scan.progress && { ...scan.progress, etaMs: 0 } })),
  });
}

// ---------------------------------------------------------------------------------------------
// The dashboard

export interface DashboardLiveSnapshot {
  serverNow: number;
  assignments: Array<{
    id: string;
    title: string;
    keyStatus: KeyStatus;
    keyApproved: boolean;
    counts: StatusCounts;
    progress: { done: number; total: number } | null;
    scans: { splitting: number; review: number; failed: number };
  }>;
}

/** The dashboard's cards in short: enough to tell when one of them changed (the page then re-renders them). */
export function buildDashboardLiveSnapshot(view: DashboardView, now: number): DashboardLiveSnapshot {
  return {
    serverNow: now,
    assignments: view.assignments.map((a) => ({
      id: a.id,
      title: a.title,
      keyStatus: a.keyStatus,
      keyApproved: a.keyApproved,
      counts: a.counts,
      progress: a.progress,
      scans: { splitting: a.scans.splitting, review: a.scans.review, failed: a.scans.failed },
    })),
  };
}

export function dashboardLiveSignature(s: DashboardLiveSnapshot): string {
  return JSON.stringify(s.assignments);
}
