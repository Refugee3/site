import { getConfig } from "@/lib/config";
import { getAssignment, getAssignmentByShareCode, listAssignmentsForTeacher, listSections } from "@/lib/db/repos/assignments";
import { listKeyItems } from "@/lib/db/repos/keys";
import {
  countByStatus, getSubmissionByReceipt, listItems, listItemsForAssignment, listStaleIds, listSubmissions,
} from "@/lib/db/repos/submissions";
import { FLAG_DEFS } from "@/lib/flags";
import { formatPercent, formatPoints, STATUS_LABEL } from "@/lib/format";
import { nextNeedsReview, organizeBoard, type BoardGroup } from "@/lib/grading/board";
import { toCsv } from "@/lib/grading/csv";
import { computeScore, roundHalfUpDiv } from "@/lib/grading/scoring";
import { sectionsToText } from "@/lib/grading/sections";
import { getWorkerStatus } from "@/lib/jobs/queue";
import { isKeyLocked, loadKeyState, requireKey } from "@/lib/services/key-state";
import { receiptUrl } from "@/lib/services/submissions";
import type {
  AiUsage, Assignment, AssignmentHeader, BoardFilter, BoardRow, BoardView, DashboardView, FlagCode, KeyEditorView, KeyItem,
  ReceiptNotice, ReceiptPhase, ReceiptView, ReviewView, ScoreResult, SettingsView, StudentUploadView, Submission,
  SubmissionItem, SubmissionStatus, Teacher,
} from "@/lib/types";

const MIB = 1_048_576;
const UNNAMED = "No name";

// ---------------------------------------------------------------------------------------------
// Teacher pages

export function getDashboardView(t: Teacher): DashboardView {
  return {
    teacher: t,
    worker: getWorkerStatus(),
    assignments: listAssignmentsForTeacher(t.id).map((a) => {
      const { key, approved } = loadKeyState(a.id);
      return {
        id: a.id,
        title: a.title,
        status: a.status,
        shareCode: a.shareCode,
        keyStatus: key.status,
        keyApproved: approved,
        counts: countByStatus(a.id),
        released: a.feedbackReleasedAt !== null,
        createdAt: a.createdAt,
      };
    }),
  };
}

export function getAssignmentHeader(a: Assignment, origin: string): AssignmentHeader {
  const { key, items, approved } = loadKeyState(a.id);
  return {
    assignment: a,
    shareUrl: `${origin}/s/${a.shareCode}`,
    keyStatus: key.status,
    keyApproved: approved,
    itemCount: items.length,
    totalPointsCenti: items.reduce((sum, item) => sum + item.pointsCenti, 0),
    counts: countByStatus(a.id),
    staleCount: listStaleIds(a.id, key.revision).length,
    canOpen: approved && a.status !== "open",
    worker: getWorkerStatus(),
  };
}

const BOARD_FILTERS: Record<BoardFilter, (status: SubmissionStatus) => boolean> = {
  all: () => true,
  needs_review: (status) => status === "needs_review",
  in_progress: (status) => status === "queued" || status === "grading",
  failed: (status) => status === "failed",
  graded: (status) => status === "graded",
};

export function getBoardView(a: Assignment, filter: BoardFilter): BoardView {
  const { revision } = requireKey(a.id);
  const counts = countByStatus(a.id);
  const groups = organizeBoard(listSubmissions(a.id), listSections(a.id))
    .map((group) => ({
      key: group.key,
      label: group.label,
      rows: group.rows.filter((row) => BOARD_FILTERS[filter](row.current.status)).map((row) => boardRow(row, revision)),
    }))
    .filter((group) => group.rows.length > 0);
  return {
    filter,
    groups,
    counts,
    staleCount: listStaleIds(a.id, revision).length,
    active: counts.queued + counts.grading > 0,
    open: a.status === "open",
  };
}

function boardRow({ current: s, earlier }: BoardGroup["rows"][number], keyRevision: number): BoardRow {
  return {
    submissionId: s.id,
    displayName: s.studentName ?? UNNAMED,
    status: s.status,
    statusNote: s.statusNote,
    source: s.source,
    ...cachedScore(s),
    flags: s.flags,
    stale: isStale(s, keyRevision),
    earlier: earlier.map(attemptSummary),
    pageCount: s.pageCount,
    createdAt: s.createdAt,
  };
}

/** The score cache, shown only for graded papers: queued and failed ones would show a misleading 0. */
function cachedScore(s: Submission): Pick<BoardRow, "scoreEarnedCenti" | "scoreMaxCenti" | "percentTenths"> {
  const { scoreEarnedCenti: earned, scoreMaxCenti: max } = s;
  if (!hasGrade(s) || earned === null || max === null) return { scoreEarnedCenti: null, scoreMaxCenti: null, percentTenths: null };
  return { scoreEarnedCenti: earned, scoreMaxCenti: max, percentTenths: percentTenths(earned, max) };
}

export function getKeyEditorView(a: Assignment): KeyEditorView {
  const key = requireKey(a.id);
  const counts = countByStatus(a.id);
  return {
    key,
    items: listKeyItems(a.id),
    keyPdfUrl: key.sourcePdfPath ? `/api/teacher/assignments/${a.id}/key/pdf` : null,
    gradedCount: counts.graded + counts.needs_review,
    locked: isKeyLocked(a.id),
  };
}

export function getReviewView(s: Submission, a: Assignment, origin: string): ReviewView {
  const sections = listSections(a.id);
  const { key, items } = loadKeyState(a.id);
  const results = listItems(s.id);
  const score = scoreOf(s, a, items, results);
  const resultByItem = new Map(results.map((result) => [result.itemId, result]));

  const groups = organizeBoard(listSubmissions(a.id), sections);
  // An earlier attempt has no row of its own; it navigates from the row of its newest attempt.
  const rows = groups.flatMap((group) => group.rows);
  const index = rows.findIndex((row) => row.current.id === s.id || row.earlier.some((e) => e.id === s.id));
  const row = rows[index];
  const attempts = row ? [row.current, ...row.earlier] : [];

  return {
    submission: s,
    sections,
    sectionLabel: sections.find((section) => section.id === s.sectionId)?.label ?? null,
    items: items.map((item, i) => ({ item, result: resultByItem.get(item.id) ?? null, score: score.items[i] })),
    score,
    flags: s.flags.map((code) => ({ code, ...FLAG_DEFS[code] })),
    stale: isStale(s, key.revision),
    pdfUrl: `/api/teacher/submissions/${s.id}/pdf`,
    receiptUrl: receiptUrl(s.receiptToken, origin),
    prevId: index > 0 ? rows[index - 1].current.id : null,
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].current.id : null,
    nextNeedsReviewId: nextNeedsReview(groups, s.id),
    // Attempts are newest first, so the ones after this paper are older.
    earlierAttempts: attempts.slice(attempts.findIndex((attempt) => attempt.id === s.id) + 1).map(attemptSummary),
  };
}

export function getSettingsView(a: Assignment): SettingsView {
  const cfg = getConfig();
  const paperUsages = listSubmissions(a.id).map((s) => s.usage).filter((usage) => usage !== null);
  const keyUsage = requireKey(a.id).usage;
  const total = sumUsage(keyUsage ? [keyUsage, ...paperUsages] : paperUsages);
  return {
    sectionsText: sectionsToText(listSections(a.id)),
    usage: { papers: paperUsages.length, ...total, estimatedCostUsd: estimateCostUsd(total, cfg.model, cfg.cacheTtl) },
  };
}

function sumUsage(usages: AiUsage[]): AiUsage {
  const total: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const u of usages) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheReadTokens += u.cacheReadTokens;
    total.cacheWriteTokens += u.cacheWriteTokens;
  }
  return total;
}

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: Record<"5m" | "1h", number>;
}

/** USD per million tokens. Cache writes cost more with the 1-hour TTL. */
const PRICES_PER_MTOK = new Map<string, ModelPrice>([
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: { "5m": 5, "1h": 8 } }],
]);

/** Estimated cost of the usage, or null for a model without a known price. */
export function estimateCostUsd(u: AiUsage, model: string, ttl: "5m" | "1h"): number | null {
  const price = PRICES_PER_MTOK.get(model);
  if (!price) return null;
  const dollarsPerMillion = u.inputTokens * price.input + u.outputTokens * price.output
    + u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite[ttl];
  return dollarsPerMillion / 1_000_000;
}

// ---------------------------------------------------------------------------------------------
// Student pages (authorized by share code or receipt token only)

export function getStudentUploadView(code: string): StudentUploadView | null {
  const a = getAssignmentByShareCode(code);
  if (!a) return null;
  const cfg = getConfig();
  return {
    code: a.shareCode,
    title: a.title,
    instructions: a.instructions,
    teacherName: a.teacherName,
    status: a.status,
    accepting: a.status === "open",
    maxUploadMb: cfg.maxUploadBytes / MIB,
    maxPages: cfg.maxPages,
    maxFiles: cfg.maxUploadFiles,
  };
}

const RECEIPT_NOTICES: Array<[FlagCode, ReceiptNotice]> = [
  ["name_missing", "no_name"],
  ["wrong_assignment", "wrong_assignment"],
  ["blank_submission", "blank"],
  ["pages_missing", "pages_missing"],
];

/** What a student sees on their receipt (§1.2, §8): results only once released, and never for a paper under review. */
export function getReceiptView(token: string): ReceiptView | null {
  const s = getSubmissionByReceipt(token);
  const a = s && getAssignment(s.assignmentId);
  if (!s || !a) return null;
  const phase = receiptPhase(s, a);
  return {
    assignmentTitle: a.title,
    shareCode: a.shareCode,
    submittedAt: s.createdAt,
    pageCount: s.pageCount,
    phase,
    pdfUrl: `/api/r/${token}/pdf`,
    detectedName: s.studentName,
    detectedSection: listSections(a.id).find((section) => section.id === s.sectionId)?.label ?? s.aiSectionRaw,
    notices: phase === "checked" ? RECEIPT_NOTICES.filter(([flag]) => s.flags.includes(flag)).map(([, notice]) => notice) : [],
    result: phase === "released" ? releasedResult(s, a) : null,
  };
}

function receiptPhase(s: Submission, a: Assignment): ReceiptPhase {
  if (s.status === "queued" || s.status === "grading") return "processing";
  if (s.status === "failed") return "problem";
  if (a.feedbackReleasedAt !== null && s.status === "graded") return "released";
  return "checked";
}

function releasedResult(s: Submission, a: Assignment): NonNullable<ReceiptView["result"]> {
  const items = listKeyItems(a.id);
  const results = listItems(s.id);
  const score = scoreOf(s, a, items, results);
  const resultByItem = new Map(results.map((result) => [result.itemId, result]));

  const groups: NonNullable<ReceiptView["result"]>["groups"] = [];
  items.forEach((item, i) => {
    const result = resultByItem.get(item.id);
    const entry = {
      label: item.label,
      earnedCenti: score.items[i].earnedCenti,
      maxCenti: score.items[i].maxCenti,
      whatStudentDid: result?.judgment?.whatStudentDid ?? "",
      feedback: result?.overrideFeedback ?? result?.judgment?.feedback ?? "",
    };
    // Consecutive parts of one question share a group; standalone items share the "" group.
    const last = groups.at(-1);
    if (last && last.groupLabel === item.groupLabel) last.items.push(entry);
    else groups.push({ groupLabel: item.groupLabel, items: [entry] });
  });

  return {
    earnedCenti: score.earnedCenti,
    maxCenti: score.maxCenti,
    percentTenths: score.percentTenths,
    overallFeedback: s.overallFeedback,
    groups,
  };
}

// ---------------------------------------------------------------------------------------------
// CSV export (§6.6)

const CSV_COLUMNS = [
  "Section", "Student name", "Status", "Points earned", "Points possible", "Percent", "Completion %", "Accuracy %",
  "Reviewed", "Flags", "Overall feedback", "Submitted at", "Receipt link",
];

/** Current papers in board order, scored from the live key, judgments and overrides (like the review page). */
export function buildGradesCsv(a: Assignment, origin: string): { filename: string; csv: string } {
  const items = listKeyItems(a.id);
  const resultsBySubmission = listItemsForAssignment(a.id);
  const header = [...CSV_COLUMNS, ...items.map((item) => `${item.label} (${formatPoints(item.pointsCenti)} pt)`)];
  const rows = organizeBoard(listSubmissions(a.id), listSections(a.id)).flatMap((group) =>
    group.rows.map(({ current }) => csvRow(group.label, current, a, items, resultsBySubmission.get(current.id) ?? [], origin)));
  return { filename: `${slugify(a.title)}-grades.csv`, csv: toCsv([header, ...rows]) };
}

function csvRow(
  sectionLabel: string, s: Submission, a: Assignment, items: KeyItem[], results: SubmissionItem[], origin: string,
): Array<string | null> {
  const identity = [sectionLabel, s.studentName ?? "", STATUS_LABEL[s.status]];
  const trailing = [
    s.reviewedAt !== null ? "yes" : "",
    s.flags.filter((flag) => FLAG_DEFS[flag].severity === "review").map((flag) => FLAG_DEFS[flag].label).join("; "),
    s.overallFeedback,
    new Date(s.createdAt).toISOString(),
    receiptUrl(s.receiptToken, origin),
  ];
  if (!hasGrade(s)) {
    // Not graded yet (or grading failed): leave the score columns empty rather than report a 0.
    return [...identity, "", "", "", "", "", ...trailing, ...items.map(() => "")];
  }
  const score = scoreOf(s, a, items, results);
  return [
    ...identity,
    formatPoints(score.earnedCenti),
    formatPoints(score.maxCenti),
    formatPercent(score.percentTenths),
    formatPercent(percentTenths(score.completionCenti, score.maxCenti)),
    formatPercent(percentTenths(score.accuracyCenti, score.maxCenti)),
    ...trailing,
    ...score.items.map((item) => (item.computedCenti === null && !item.overridden ? "" : formatPoints(item.earnedCenti))),
  ];
}

/** Lowercase, runs of anything but [a-z0-9] become "-", at most 50 characters; "assignment" when nothing is left. */
function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return slug || "assignment";
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

function scoreOf(s: Submission, a: Assignment, items: KeyItem[], results: SubmissionItem[]): ScoreResult {
  return computeScore(items, new Map(results.map((result) => [result.itemId, result])), a, s.totalOverrideCenti);
}

function hasGrade(s: Submission): boolean {
  return s.status === "graded" || s.status === "needs_review";
}

/** Graded against an older key revision (§6.3); the paper keeps its score until regraded. */
function isStale(s: Submission, keyRevision: number): boolean {
  return hasGrade(s) && s.gradedKeyRevision !== null && s.gradedKeyRevision < keyRevision;
}

function percentTenths(earnedCenti: number, maxCenti: number): number | null {
  return maxCenti > 0 ? roundHalfUpDiv(earnedCenti * 1000, maxCenti) : null;
}

function attemptSummary(s: Submission): { submissionId: string; createdAt: number; status: SubmissionStatus } {
  return { submissionId: s.id, createdAt: s.createdAt, status: s.status };
}
