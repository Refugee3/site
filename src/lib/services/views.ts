import { currentGraderEngine, getHostedAgentStatus } from "@/lib/ai";
import { getConfig } from "@/lib/config";
import {
  countOpenAssignments, getAssignment, getAssignmentByShareCode, getAssignmentUsage, listAssignmentsForTeacher, listSections,
  type ModelUsage,
} from "@/lib/db/repos/assignments";
import { queuedJobsAhead } from "@/lib/db/repos/jobs";
import { listKeyItems } from "@/lib/db/repos/keys";
import { listLessons, listLessonsForSubmission } from "@/lib/db/repos/lessons";
import { countPendingScans, listScans } from "@/lib/db/repos/scans";
import { getAppSettings, getGradingEngine } from "@/lib/db/repos/settings";
import {
  countByStatus, countSubmissions, getSubmissionByReceipt, listGuidanceStaleIds, listItems, listItemsForAssignment, listStaleIds,
  listSubmissions,
} from "@/lib/db/repos/submissions";
import { getGradingPreferences, getTeacher } from "@/lib/db/repos/teachers";
import { FLAG_DEFS } from "@/lib/flags";
import { formatPercent, formatPoints, STATUS_LABEL } from "@/lib/format";
import { boardOrderIds, countCurrent, inBoardFilter, nextNeedsReview, organizeBoard, type BoardGroup } from "@/lib/grading/board";
import { toCsv } from "@/lib/grading/csv";
import { computeScore, percentTenths } from "@/lib/grading/scoring";
import { sectionsToText } from "@/lib/grading/sections";
import { keyPageCountHint } from "@/lib/grading/split";
import { getWorkerStatus } from "@/lib/jobs/queue";
import { decryptSecret } from "@/lib/secrets";
import { isGuidanceStale, loadGuidance } from "@/lib/services/guidance";
import { isKeyLocked, loadKeyState, requireKey } from "@/lib/services/key-state";
import { studentUploadsEnabled } from "@/lib/services/settings";
import { getGradingCounts, getGradingProgress, getSplitProgress, typicalExtractionMs, typicalPaperMs } from "@/lib/services/progress";
import { currentOnly, receiptUrl } from "@/lib/services/submissions";
import type {
  AiUsage, Assignment, AssignmentHeader, BoardFilter, BoardRow, BoardView, DashboardView, FlagCode, KeyEditorView, KeyItem,
  LessonsView, LessonView, ReceiptNotice, ReceiptPhase, ReceiptView, ReviewView, Scan, ScanReviewView, ScanSummary, ScoreResult,
  SettingsView, StatusCounts, StudentUploadView, Submission, SubmissionItem, SubmissionStatus, Teacher, TeacherSettingsView,
  UploadPageView,
} from "@/lib/types";

const MIB = 1_048_576;
const UNNAMED = "No name";

// ---------------------------------------------------------------------------------------------
// Teacher pages

export function getDashboardView(t: Teacher): DashboardView {
  return {
    studentsCanUpload: studentUploadsEnabled(),
    assignments: listAssignmentsForTeacher(t.id).map((a) => {
      const { key, approved } = loadKeyState(a.id);
      return {
        id: a.id,
        title: a.title,
        kind: a.kind,
        status: a.status,
        shareCode: a.shareCode,
        keyStatus: key.status,
        keyApproved: approved,
        counts: currentCounts(a.id),
        scans: countPendingScans(a.id),
        released: a.feedbackReleasedAt !== null,
        createdAt: a.createdAt,
        progress: getGradingCounts(a.id),
      };
    }),
  };
}

export function getAssignmentHeader(a: Assignment, origin: string): AssignmentHeader {
  const { key, items, approved } = loadKeyState(a.id);
  const studentsCanUpload = studentUploadsEnabled();
  return {
    assignment: a,
    shareUrl: `${origin}/s/${a.shareCode}`,
    keyStatus: key.status,
    keyApproved: approved,
    itemCount: items.length,
    totalPointsCenti: items.reduce((sum, item) => sum + item.pointsCenti, 0),
    counts: currentCounts(a.id),
    canOpen: approved && a.status !== "open" && studentsCanUpload,
    studentsCanUpload,
  };
}

/**
 * Status counts of the papers the board shows (current attempts only), like the CSV. Counting folded
 * earlier attempts would ask the teacher to review papers no filter shows.
 */
function currentCounts(assignmentId: string): StatusCounts {
  return countCurrent(organizeBoard(listSubmissions(assignmentId), listSections(assignmentId)));
}

export function getBoardView(a: Assignment, filter: BoardFilter): BoardView {
  const { revision } = requireKey(a.id);
  const studentsCanUpload = studentUploadsEnabled();
  const submissions = listSubmissions(a.id);
  const board = organizeBoard(submissions, listSections(a.id));
  const current = new Set(boardOrderIds(board));
  const scans = countPendingScans(a.id);
  const groups = board
    .map((group) => ({
      key: group.key,
      label: group.label,
      rows: group.rows.filter((row) => inBoardFilter(filter, row.current.status)).map((row) => boardRow(row, revision)),
    }))
    .filter((group) => group.rows.length > 0);
  return {
    groups,
    counts: countCurrent(board),
    scans,
    staleCount: listStaleIds(a.id, revision).filter((id) => current.has(id)).length,
    guidanceStaleCount: listGuidanceStaleIds(a.id, revision, loadGuidance(a).fingerprint).filter((id) => current.has(id)).length,
    // Polls while anything is being graded, including a regraded earlier attempt, or a scan is being split.
    active: submissions.some((s) => s.status === "queued" || s.status === "grading") || scans.splitting > 0,
    open: studentsCanUpload && a.status === "open",
    studentsCanUpload,
    progress: getGradingProgress(a.id),
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
    studentsCanUpload: studentUploadsEnabled(),
    extraction: key.status === "processing"
      ? { extractionStartedAt: key.processingStartedAt ?? key.updatedAt, typicalExtractionMs: typicalExtractionMs() }
      : null,
  };
}

export function getReviewView(s: Submission, a: Assignment, origin: string): ReviewView {
  const sections = listSections(a.id);
  const { key, items } = loadKeyState(a.id);
  const results = listItems(s.id);
  const score = scoreOf(s, a, items, results);
  const resultByItem = new Map(results.map((result) => [result.itemId, result]));
  const lessonByItem = new Map(listLessonsForSubmission(s.id).map((lesson) => [lesson.itemId, lesson]));
  const guidance = loadGuidance(a, items);

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
    items: items.map((item, i) => {
      const lesson = lessonByItem.get(item.id);
      return {
        item, result: resultByItem.get(item.id) ?? null, score: score.items[i],
        lesson: lesson
          ? {
            id: lesson.id, reason: lesson.reason, active: lesson.active, sent: guidance.sentIds.includes(lesson.id),
            notSent: guidance.notSent[lesson.id] ?? null,
          }
          : null,
      };
    }),
    score,
    stale: isStale(s, key.revision),
    guidanceStale: isGuidanceStale(s, key.revision, guidance.fingerprint, results),
    pdfUrl: `/api/teacher/submissions/${s.id}/pdf`,
    receiptUrl: receiptUrl(s.receiptToken, origin),
    prevId: index > 0 ? rows[index - 1].current.id : null,
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].current.id : null,
    nextNeedsReviewId: nextNeedsReview(groups, s.id),
    // Attempts are newest first, so the ones after this paper are older.
    earlierAttempts: attempts.slice(attempts.findIndex((attempt) => attempt.id === s.id) + 1).map(attemptSummary),
    released: a.feedbackReleasedAt !== null,
    gradingEngine: currentGraderEngine(),
    queue: s.status === "queued" ? queuePosition(s.id) : null,
    gradingTiming: s.status === "grading"
      ? { gradingStartedAt: s.gradingStartedAt ?? s.updatedAt, typicalPaperMs: typicalPaperMs(a.id) }
      : null,
  };
}

/** Null when the paper has no queued job (its run is being recorded, or the worker puts it back at the next start). */
function queuePosition(submissionId: string): { position: number } | null {
  const position = queuedJobsAhead("grade_submission", submissionId);
  return position === null ? null : { position };
}

/**
 * The Lessons tab: every lesson grouped by key item (key order), newest first within an item, with whether
 * the grader is sent it and, if not, why.
 */
export function getLessonsView(a: Assignment): LessonsView {
  const { key, items } = loadKeyState(a.id);
  const guidance = loadGuidance(a, items);
  const sent = new Set(guidance.sentIds);
  const lessons = listLessons(a.id);
  const views: LessonView[] = items.flatMap((item) =>
    lessons.filter((lesson) => lesson.itemId === item.id).map((lesson) => ({
      lesson,
      itemLabel: item.label,
      itemPosition: item.position,
      itemMaxCenti: item.pointsCenti,
      sent: sent.has(lesson.id),
      notSent: guidance.notSent[lesson.id] ?? null,
      paperHref: lesson.submissionId ? `/teacher/assignments/${a.id}/submissions/${lesson.submissionId}` : null,
      paperDeleted: lesson.submissionId === null,
    })));
  return {
    lessons: views,
    activeCount: lessons.filter((lesson) => lesson.active).length,
    sentCount: guidance.sentIds.length,
    guidanceStaleCount: currentOnly(a.id, listGuidanceStaleIds(a.id, key.revision, guidance.fingerprint)).length,
    hasPreferences: guidance.guidance.preferences.trim() !== "",
  };
}

export function getUploadPageView(a: Assignment): UploadPageView {
  const cfg = getConfig();
  const { key, items, approved } = loadKeyState(a.id);
  return {
    keyApproved: approved,
    keyPageCount: keyPageCountHint(key, items),
    scans: listScans(a.id).map(scanSummary),
    maxUploadMb: cfg.maxUploadBytes / MIB,
    maxPages: cfg.maxPages,
    maxScanMb: cfg.maxScanBytes / MIB,
    maxScanPages: cfg.maxScanPages,
    studentsCanUpload: studentUploadsEnabled(),
  };
}

function scanSummary(s: Scan): ScanSummary {
  return {
    id: s.id, status: s.status, originalFilename: s.originalFilename, pageCount: s.pageCount, createdAt: s.createdAt,
    createdCount: s.createdCount, autoGraded: s.autoGraded,
  };
}

/** The scan's split for the teacher to check; the stored path, hash and AI accounting stay on the server. */
export function getScanReviewView(scan: Scan, a: Assignment): ScanReviewView {
  const { key, items, approved } = loadKeyState(a.id);
  return {
    scan: shownScan(scan),
    pdfUrl: `/api/teacher/scans/${scan.id}/pdf`,
    keyApproved: approved,
    keyPageCount: keyPageCountHint(key, items),
    maxPagesPerPaper: getConfig().maxPages,
    remainingSubmissions: Math.max(0, a.maxSubmissions - countSubmissions(a.id)),
    splitProgress: getSplitProgress(scan),
  };
}

/** An allowlist, so a field added to Scan later reaches the browser only when it is added here. */
function shownScan(s: Scan): ScanReviewView["scan"] {
  return {
    id: s.id, assignmentId: s.assignmentId, status: s.status, splitMode: s.splitMode, pagesPerPaper: s.pagesPerPaper,
    splitGeneration: s.splitGeneration, originalFilename: s.originalFilename, byteSize: s.byteSize, pageCount: s.pageCount,
    readings: s.readings, pagesRead: s.pagesRead, layout: s.layout, proposedLayout: s.proposedLayout, statusNote: s.statusNote,
    errorMessage: s.errorMessage, createdCount: s.createdCount, duplicateCount: s.duplicateCount, splitStartedAt: s.splitStartedAt,
    splitFinishedAt: s.splitFinishedAt, autoGraded: s.autoGraded, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

/**
 * /teacher/settings. The saved key is decrypted only to learn whether it still can be; the view carries its
 * masked form alone.
 */
export function getTeacherSettingsView(t: Teacher): TeacherSettingsView {
  const cfg = getConfig();
  const settings = getAppSettings();
  const stored = settings.apiKeyCiphertext;
  const readable = stored !== null && decryptSecret(stored, "anthropic-api-key") !== null;
  const setBy = readable && settings.apiKeySetBy !== null ? getTeacher(settings.apiKeySetBy) : null;
  return {
    apiKey: {
      source: readable ? "app" : cfg.hasApiKey ? "env" : "none",
      masked: readable ? settings.apiKeyMasked : null,
      check: readable ? settings.apiKeyCheck : null,
      setAt: readable ? settings.apiKeySetAt : null,
      setByName: setBy?.displayName ?? null,
      unreadable: stored !== null && !readable,
      envKeySet: cfg.hasApiKey,
    },
    aiMode: cfg.aiMode,
    aiModel: settings.aiModel,
    studentsCanUpload: settings.studentsCanUpload,
    openAssignmentCount: countOpenAssignments(),
    gradingPreferences: getGradingPreferences(t.id),
    worker: getWorkerStatus(),
    grader: { engine: getGradingEngine(), agent: getHostedAgentStatus() },
  };
}

/**
 * The assignment's AI usage: every call ever made for it (grading, regrades, retries, refusals, reading
 * the key, papers deleted since), each priced at the rate of the model that answered it.
 */
export function getSettingsView(a: Assignment): SettingsView {
  const { cacheTtl } = getConfig();
  const byModel = Object.entries(getAssignmentUsage(a.id));
  const total = sumUsage(byModel.map(([, usage]) => usage));
  const costs = byModel.map(([model, usage]) => estimateLedgerCostUsd(model, usage, cacheTtl));
  return {
    sectionsText: sectionsToText(listSections(a.id)),
    usage: {
      calls: byModel.reduce((sum, [, usage]) => sum + usage.calls, 0),
      papers: listSubmissions(a.id).filter((s) => s.usage !== null).length,
      ...total,
      estimatedCostUsd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
      agentSessions: byModel.reduce((sum, [, usage]) => sum + (usage.agent?.sessions ?? 0), 0),
      agentActiveSeconds: byModel.reduce((sum, [, usage]) => sum + (usage.agent?.activeSeconds ?? 0), 0),
    },
  };
}

/** List price of the hosted agent's running time (session runtime), on top of its tokens. */
export const AGENT_RUNTIME_USD_PER_HOUR = 0.08;

/**
 * Estimated cost of one model's usage, or null for a model without a known price: its direct calls priced by their
 * tokens, plus its hosted-agent sessions at the list cost Anthropic reported for them or, when any session reported
 * none, estimated from their tokens and running time.
 */
export function estimateLedgerCostUsd(model: string, entry: ModelUsage, ttl: "5m" | "1h"): number | null {
  const { agent } = entry;
  const direct: AiUsage = agent
    ? {
      inputTokens: entry.inputTokens - agent.inputTokens,
      outputTokens: entry.outputTokens - agent.outputTokens,
      cacheReadTokens: entry.cacheReadTokens - agent.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens - agent.cacheWriteTokens,
    }
    : entry;
  // Calls that used no tokens (the fake grader) cost nothing, whatever their model is called.
  const directCost = tokenCount(direct) === 0 ? 0 : estimateCostUsd(direct, model, ttl);
  if (directCost === null || !agent) return directCost;
  if (agent.unpricedSessions === 0) return directCost + agent.listCostCents / 100;
  const agentTokenCost = estimateCostUsd(agent, model, ttl);
  if (agentTokenCost === null) return null;
  return directCost + agentTokenCost + (agent.activeSeconds * AGENT_RUNTIME_USD_PER_HOUR) / 3600;
}

function tokenCount(u: AiUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
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

/** List price with cache writes at 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL. */
function listPrice(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: { "5m": input * 1.25, "1h": input * 2 } };
}

/**
 * USD per million tokens, for each model that can answer: the two in Settings → AI model (Sonnet 5.5 also splits
 * scans), and the models server-side fallbacks may hand a declined request to, which bill at their own prices.
 */
const PRICES_PER_MTOK = new Map<string, ModelPrice>([
  ["claude-sonnet-5-5", listPrice(2, 10, 0.2)],
  ["claude-opus-5-5", listPrice(4, 20, 0.2)],
  // Fallbacks: Sonnet 5 for Sonnet 5.5; Opus 5 or Opus 4.8 for Opus 5.5.
  ["claude-sonnet-5", listPrice(2, 10, 0.2)],
  ["claude-opus-5", listPrice(5, 25, 0.5)],
  ["claude-opus-4-8", listPrice(5, 25, 0.5)],
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
    accepting: studentUploadsEnabled() && a.status === "open",
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

/**
 * What a student sees on their receipt: results only once released, and never for a paper
 * under review. Never the assignment's current share code: a rotated code must not leak through old receipts.
 */
export function getReceiptView(token: string): ReceiptView | null {
  const s = getSubmissionByReceipt(token);
  const a = s && getAssignment(s.assignmentId);
  if (!s || !a) return null;
  const phase = receiptPhase(s, a);
  // Once the teacher has reviewed and accepted the paper, its warnings no longer ask the student to resubmit.
  const showNotices = phase === "checked" && s.reviewedAt === null;
  return {
    assignmentTitle: a.title,
    submittedAt: s.createdAt,
    pageCount: s.pageCount,
    phase,
    pdfUrl: `/api/r/${token}/pdf`,
    detectedName: s.studentName,
    detectedSection: listSections(a.id).find((section) => section.id === s.sectionId)?.label ?? s.aiSectionRaw,
    notices: showNotices ? RECEIPT_NOTICES.filter(([flag]) => s.flags.includes(flag)).map(([, notice]) => notice) : [],
    result: phase === "released" ? releasedResult(s, a) : null,
    canResubmit: studentUploadsEnabled(),
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
      whatStudentDid: result?.overrideWhatStudentDid ?? result?.judgment?.whatStudentDid ?? "",
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
// CSV export

const CSV_COLUMNS = [
  "Section", "Student name", "Status", "Points earned", "Points possible", "Percent", "Completion %", "Accuracy %",
  "Reviewed", "Flags", "Overall feedback", "Submitted at", "Earlier attempts", "Receipt link",
];

/**
 * Current papers in board order, scored from the live key, judgments and overrides (like the review
 * page). "Earlier attempts" counts the papers folded under each row, so a merge is visible in the export.
 */
export function buildGradesCsv(a: Assignment, origin: string): { filename: string; csv: string } {
  const items = listKeyItems(a.id);
  const resultsBySubmission = listItemsForAssignment(a.id);
  const header = [...CSV_COLUMNS, ...items.map((item) => `${item.label} (${formatPoints(item.pointsCenti)} pt)`)];
  const rows = organizeBoard(listSubmissions(a.id), listSections(a.id)).flatMap((group) =>
    group.rows.map(({ current, earlier }) =>
      csvRow(group.label, current, earlier.length, a, items, resultsBySubmission.get(current.id) ?? [], origin)));
  return { filename: `${slugify(a.title)}-grades.csv`, csv: toCsv([header, ...rows]) };
}

function csvRow(
  sectionLabel: string, s: Submission, earlierAttempts: number, a: Assignment, items: KeyItem[], results: SubmissionItem[],
  origin: string,
): Array<string | null> {
  const identity = [sectionLabel, s.studentName ?? "", STATUS_LABEL[s.status]];
  const trailing = [
    s.reviewedAt !== null ? "yes" : "",
    s.flags.filter((flag) => FLAG_DEFS[flag].severity === "review").map((flag) => FLAG_DEFS[flag].label).join("; "),
    s.overallFeedback,
    new Date(s.createdAt).toISOString(),
    earlierAttempts > 0 ? String(earlierAttempts) : "",
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

/** Graded against an older key revision; the paper keeps its score until regraded. */
function isStale(s: Submission, keyRevision: number): boolean {
  return hasGrade(s) && s.gradedKeyRevision !== null && s.gradedKeyRevision < keyRevision;
}

function attemptSummary(s: Submission): { submissionId: string; createdAt: number; status: SubmissionStatus } {
  return { submissionId: s.id, createdAt: s.createdAt, status: s.status };
}
