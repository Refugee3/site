import { currentGraderEngine, getHostedAgentStatus } from "@/lib/ai";
import { getConfig } from "@/lib/config";
import {
  getAssignmentUsage, listAssignmentsForTeacher, listSections, type ModelUsage,
} from "@/lib/db/repos/assignments";
import { queuedJobsAhead } from "@/lib/db/repos/jobs";
import { listKeyItems } from "@/lib/db/repos/keys";
import { listLessons, listLessonsForSubmission } from "@/lib/db/repos/lessons";
import { countPendingScans, listScans } from "@/lib/db/repos/scans";
import { getAppSettings, getGradingEngine, getOllamaSpeedSettings } from "@/lib/db/repos/settings";
import { onePassAvailable } from "@/lib/services/scans";
import {
  countByStatus, countSubmissions, listGuidanceStaleIds, listItems, listItemsForAssignment, listStaleIds,
  listSubmissions, recentLocalPaperTimes,
} from "@/lib/db/repos/submissions";
import { getGradingPreferences, getTeacher } from "@/lib/db/repos/teachers";
import { FLAG_DEFS } from "@/lib/flags";
import { formatPercent, formatPoints, STATUS_LABEL } from "@/lib/format";
import { boardOrderIds, countCurrent, inBoardFilter, nextNeedsReview, organizeBoard, type BoardGroup } from "@/lib/grading/board";
import { type AnswerMatchSummary, findAnswerMatches, MATCH_MIN_PAPERS } from "@/lib/grading/answer-match";
import { toCsv } from "@/lib/grading/csv";
import { estimateCostUsd } from "@/lib/pricing";
import { median } from "@/lib/grading/estimates";
import {
  commonAnswers, computeItemStats, isCountedStatus, MISS_HIGHLIGHT_MIN_PAPERS, paperOutcomes, type ItemStatsSummary,
} from "@/lib/grading/item-stats";
import { computeScore, percentTenths } from "@/lib/grading/scoring";
import { sectionsToText } from "@/lib/grading/sections";
import { keyPageCountHint } from "@/lib/grading/split";
import { getWorkerStatus } from "@/lib/jobs/queue";
import { decryptSecret } from "@/lib/secrets";
import { isGuidanceStale, loadGuidance } from "@/lib/services/guidance";
import { isKeyLocked, loadKeyState, requireKey } from "@/lib/services/key-state";
import { getGradingCounts, getGradingProgress, getSplitProgress, typicalExtractionMs, typicalPaperMs } from "@/lib/services/progress";
import { currentOnly, spotsStaleIds } from "@/lib/services/submissions";
import type {
  AiUsage, Assignment, AssignmentHeader, BoardFilter, BoardRow, BoardView, DashboardView, KeyEditorView, KeyItem, LessonsView,
  LessonView, OllamaSpeedView, ReviewView, Scan, ScanReviewView, ScanSummary, ScoreResult, SettingsView, StatusCounts, Submission,
  SubmissionItem,
  StrugglingQuestion, SubmissionStatus, Teacher, TeacherSettingsView, UploadPageView,
} from "@/lib/types";

const MIB = 1_048_576;
const UNNAMED = "No name";

// ---------------------------------------------------------------------------------------------
// Teacher pages

export function getDashboardView(t: Teacher): DashboardView {
  return {
    assignments: listAssignmentsForTeacher(t.id).map((a) => {
      const { key, approved } = loadKeyState(a.id);
      return {
        id: a.id,
        title: a.title,
        kind: a.kind,
        keyStatus: key.status,
        keyApproved: approved,
        counts: currentCounts(a.id),
        scans: countPendingScans(a.id),
        createdAt: a.createdAt,
        progress: getGradingCounts(a.id),
        averageTenths: classAverageTenths(a.id),
      };
    }),
  };
}

/** The average score of each student's current graded paper (as the board shows them), or null before any is graded. */
function classAverageTenths(assignmentId: string): number | null {
  const percents = organizeBoard(listSubmissions(assignmentId), listSections(assignmentId))
    .flatMap((group) => group.rows.map((row) => row.current))
    .filter((s) => hasGrade(s) && s.scoreEarnedCenti !== null && s.scoreMaxCenti !== null && s.scoreMaxCenti > 0)
    .map((s) => percentTenths(s.scoreEarnedCenti!, s.scoreMaxCenti!))
    .filter((p): p is number => p !== null);
  return percents.length === 0 ? null : Math.round(percents.reduce((a, b) => a + b, 0) / percents.length);
}

/**
 * "Where students are struggling": every question, across all of the teacher's assignments, that most of the class
 * missed (the same rule as each assignment's "Questions most students got wrong"), most missed first. Computed from the
 * stored judgments without AI calls, one pass per assignment; an assignment with too few graded papers to highlight
 * anything is skipped after reading its papers alone.
 */
export function getStrugglingQuestions(t: Teacher): StrugglingQuestion[] {
  const found: Array<{ question: StrugglingQuestion; createdAt: number; position: number }> = [];
  for (const a of listAssignmentsForTeacher(t.id)) {
    const submissions = listSubmissions(a.id);
    if (submissions.filter((s) => isCountedStatus(s.status)).length < MISS_HIGHLIGHT_MIN_PAPERS) continue;
    const stats = computeItemStats(listKeyItems(a.id), submissions, listSections(a.id), listItemsForAssignment(a.id), a);
    for (const s of stats.highlighted) {
      found.push({
        question: {
          assignmentId: a.id,
          assignmentTitle: a.title,
          kind: a.kind,
          itemId: s.item.id,
          label: s.item.label,
          prompt: s.item.prompt,
          missedTenths: s.missedTenths ?? 0,
          missedPapers: s.missedPapers,
          judged: s.judged,
        },
        createdAt: a.createdAt,
        position: s.item.position,
      });
    }
  }
  // Most missed first; ties: more students, then the newest assignment, then key order.
  found.sort((x, y) => y.question.missedTenths - x.question.missedTenths || y.question.missedPapers - x.question.missedPapers
    || y.createdAt - x.createdAt || x.position - y.position);
  return found.map((entry) => entry.question);
}

/** A quiz's matching answers (pairs of students with the same rare wrong answers); null for homework, which isn't checked. */
export function getAnswerMatches(a: Assignment): AnswerMatchSummary | null {
  if (a.kind !== "quiz") return null;
  return findAnswerMatches(listKeyItems(a.id), listSubmissions(a.id), listSections(a.id), listItemsForAssignment(a.id), a);
}

/** For the dashboard: each quiz with matching answers, newest quiz first. */
export function getQuizMatchAlerts(t: Teacher): Array<{ assignmentId: string; title: string; pairs: number; strong: number }> {
  const alerts: Array<{ assignmentId: string; title: string; pairs: number; strong: number; createdAt: number }> = [];
  for (const a of listAssignmentsForTeacher(t.id)) {
    if (a.kind !== "quiz") continue;
    const submissions = listSubmissions(a.id);
    if (submissions.filter((s) => isCountedStatus(s.status)).length < MATCH_MIN_PAPERS) continue;
    const { matches } = findAnswerMatches(listKeyItems(a.id), submissions, listSections(a.id), listItemsForAssignment(a.id), a);
    if (matches.length === 0) continue;
    alerts.push({
      assignmentId: a.id, title: a.title, pairs: matches.length, strong: matches.filter((m) => m.strength === "strong").length,
      createdAt: a.createdAt,
    });
  }
  return alerts.sort((x, y) => y.createdAt - x.createdAt).map(({ assignmentId, title, pairs, strong }) => ({ assignmentId, title, pairs, strong }));
}

export function getAssignmentHeader(a: Assignment): AssignmentHeader {
  const { key, items, approved } = loadKeyState(a.id);
  return {
    assignment: a,
    keyStatus: key.status,
    keyApproved: approved,
    itemCount: items.length,
    totalPointsCenti: items.reduce((sum, item) => sum + item.pointsCenti, 0),
    counts: currentCounts(a.id),
    scans: countPendingScans(a.id),
  };
}

/**
 * Status counts of the papers the board shows (current attempts only), like the CSV. Counting folded
 * earlier attempts would ask the teacher to review papers no filter shows.
 */
function currentCounts(assignmentId: string): StatusCounts {
  return countCurrent(organizeBoard(listSubmissions(assignmentId), listSections(assignmentId)));
}

/** `missedItemId` (`?missed=`): show only the current graded papers that missed that key item (ignored if unknown). */
export function getBoardView(a: Assignment, filter: BoardFilter, missedItemId: string | null = null): BoardView {
  const { key: { revision }, approved: keyApproved } = loadKeyState(a.id);
  const submissions = listSubmissions(a.id);
  const board = organizeBoard(submissions, listSections(a.id));
  const current = new Set(boardOrderIds(board));
  const scans = countPendingScans(a.id);
  const missedOn = missedItemId === null ? null : missedLookup(a, missedItemId);
  const groups = board
    .map((group) => ({
      key: group.key,
      label: group.label,
      rows: group.rows
        .filter((row) => inBoardFilter(filter, row.current.status))
        .flatMap((row): BoardRow[] => {
          if (!missedOn) return [boardRow(row, revision)];
          const missed = missedOn.outcome(row.current);
          return missed ? [{ ...boardRow(row, revision), missed }] : [];
        }),
    }))
    .filter((group) => group.rows.length > 0);
  const missedRows = missedOn ? groups.flatMap((group) => group.rows) : [];
  return {
    groups,
    missed: missedOn && {
      ...missedOn.item,
      count: missedRows.length,
      commonAnswers: commonAnswers(missedRows.map((row) => row.missed?.answer ?? "")),
    },
    counts: countCurrent(board),
    scans,
    staleCount: listStaleIds(a.id, revision).filter((id) => current.has(id)).length,
    guidanceStaleCount: listGuidanceStaleIds(a.id, revision, loadGuidance(a).fingerprint).filter((id) => current.has(id)).length,
    spotsStaleCount: spotsStaleIds(a).length,
    // Polls while anything is being graded, including a regraded earlier attempt, or a scan is being split.
    active: submissions.some((s) => s.status === "queued" || s.status === "grading") || scans.splitting > 0,
    keyApproved,
    progress: getGradingProgress(a.id),
  };
}

/**
 * For the board's "missed" filter: the key item, and how a current paper did on it when it counts (graded or needs
 * review) and missed it (judged, short of full accuracy credit).
 */
function missedLookup(a: Assignment, itemId: string) {
  const items = listKeyItems(a.id);
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  const resultsBySubmission = listItemsForAssignment(a.id);
  const { id, label, prompt } = items[index];
  return {
    item: { itemId: id, label, prompt },
    outcome(s: Submission): NonNullable<BoardRow["missed"]> | null {
      if (!isCountedStatus(s.status)) return null;
      const result = paperOutcomes(items, resultsBySubmission.get(s.id) ?? [], a, s.totalOverrideCenti)[index];
      return result && result.outcome !== "correct" ? { outcome: result.outcome, answer: result.studentAnswer } : null;
    },
  };
}

/** How the class did on each key item: current papers that are graded or need review (see item-stats.ts). */
export function getItemStats(a: Assignment): ItemStatsSummary {
  return computeItemStats(listKeyItems(a.id), listSubmissions(a.id), listSections(a.id), listItemsForAssignment(a.id), a);
}

/** The Questions tab: the stats, and whether papers are still being graded (the page refreshes while they are). */
export function getQuestionsView(a: Assignment): { stats: ItemStatsSummary; active: boolean } {
  const submissions = listSubmissions(a.id);
  return {
    stats: computeItemStats(listKeyItems(a.id), submissions, listSections(a.id), listItemsForAssignment(a.id), a),
    active: submissions.some((s) => s.status === "queued" || s.status === "grading"),
  };
}

function boardRow({ current: s, earlier }: BoardGroup["rows"][number], keyRevision: number): BoardRow {
  return {
    submissionId: s.id,
    displayName: s.studentName ?? UNNAMED,
    status: s.status,
    statusNote: s.statusNote,
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
    extraction: key.status === "processing"
      ? { extractionStartedAt: key.processingStartedAt ?? key.updatedAt, typicalExtractionMs: typicalExtractionMs() }
      : null,
  };
}

export function getReviewView(s: Submission, a: Assignment): ReviewView {
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
    prevId: index > 0 ? rows[index - 1].current.id : null,
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].current.id : null,
    nextNeedsReviewId: nextNeedsReview(groups, s.id),
    // Attempts are newest first, so the ones after this paper are older.
    earlierAttempts: attempts.slice(attempts.findIndex((attempt) => attempt.id === s.id) + 1).map(attemptSummary),
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
    onePassAvailable: onePassAvailable(a.id),
  };
}

function scanSummary(s: Scan): ScanSummary {
  return {
    id: s.id, status: s.status, splitMode: s.splitMode, originalFilename: s.originalFilename, pageCount: s.pageCount, createdAt: s.createdAt,
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
    onePass: scan.splitMode === "one_pass" ? onePassSummary(scan) : null,
  };
}

/** What a scan graded in one pass has done so far: no AI answers, only counts and the pages left out. */
function onePassSummary(s: Scan): NonNullable<ScanReviewView["onePass"]> {
  const papers = s.onePass?.papers ?? [];
  const graded = papers.filter((paper) => paper.submissionId !== null);
  return {
    papersGraded: graded.length,
    duplicates: papers.length - graded.length,
    flagged: graded.filter((paper) => paper.flagged).length,
    pagesDone: s.onePass ? s.onePass.nextPage - 1 : 0,
    skipped: s.onePass?.skipped ?? [],
    ...(s.onePass?.fastLane ? { fastLane: true as const } : {}),
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
    gradingPreferences: getGradingPreferences(t.id),
    worker: getWorkerStatus(),
    grader: { engine: getGradingEngine(), agent: getHostedAgentStatus(), ollama: settings.ollama },
  };
}

/** Papers in the median shown in Settings → Grader → On this computer. */
export const LOCAL_PAPER_SAMPLE = 10;

/** Settings → Grader → On this computer (Ollama): the speed settings and the median time of the last 10 local papers. */
export function getOllamaSpeedView(): OllamaSpeedView {
  const cfg = getConfig();
  const speed = getOllamaSpeedSettings();
  const times = recentLocalPaperTimes(LOCAL_PAPER_SAMPLE);
  const recent = times.length === 0
    ? null
    : {
      papers: times.length,
      medianMs: Math.round(median(times.map((t) => t.readMs + (t.judgeMs ?? 0)))!),
      medianReadMs: Math.round(median(times.map((t) => t.readMs))!),
      medianJudgeMs: Math.round(median(times.map((t) => t.judgeMs ?? 0))!),
    };
  return { ...speed, envImageMaxEdge: cfg.ollamaImageMaxEdge, envConcurrency: cfg.ollamaConcurrency, recent };
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


// ---------------------------------------------------------------------------------------------
// CSV export

const CSV_COLUMNS = [
  "Section", "Student name", "Status", "Points earned", "Points possible", "Percent", "Completion %", "Accuracy %",
  "Reviewed", "Flags", "Overall feedback", "Submitted at", "Earlier attempts",
];

/**
 * Current papers in board order, scored from the live key, judgments and overrides (like the review
 * page). "Earlier attempts" counts the papers folded under each row, so a merge is visible in the export.
 */
export function buildGradesCsv(a: Assignment): { filename: string; csv: string } {
  const items = listKeyItems(a.id);
  const resultsBySubmission = listItemsForAssignment(a.id);
  const header = [...CSV_COLUMNS, ...items.map((item) => `${item.label} (${formatPoints(item.pointsCenti)} pt)`)];
  const rows = organizeBoard(listSubmissions(a.id), listSections(a.id)).flatMap((group) =>
    group.rows.map(({ current, earlier }) =>
      csvRow(group.label, current, earlier.length, a, items, resultsBySubmission.get(current.id) ?? [])));
  return { filename: `${slugify(a.title)}-grades.csv`, csv: toCsv([header, ...rows]) };
}

function csvRow(
  sectionLabel: string, s: Submission, earlierAttempts: number, a: Assignment, items: KeyItem[], results: SubmissionItem[],
): Array<string | null> {
  const identity = [sectionLabel, s.studentName ?? "", STATUS_LABEL[s.status]];
  const trailing = [
    s.reviewedAt !== null ? "yes" : "",
    s.flags.filter((flag) => FLAG_DEFS[flag].severity === "review").map((flag) => FLAG_DEFS[flag].label).join("; "),
    s.overallFeedback,
    new Date(s.createdAt).toISOString(),
    earlierAttempts > 0 ? String(earlierAttempts) : "",
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

const QUESTION_CSV_COLUMNS = [
  "Question", "Part of", "Prompt", "Points", "Papers judged", "Correct", "Partly right", "Wrong", "Blank", "Unreadable",
  "% correct", "% missed", "Average points earned", "Average % earned", "Most students got it wrong",
];

/**
 * One row per key item, in key order: the counts and rates of getItemStats ("% missed" under accuracy scoring,
 * "Average points earned" under the assignment's own scoring). With two or more sections, a "% missed" column each.
 */
export function buildQuestionStatsCsv(a: Assignment): { filename: string; csv: string } {
  const stats = getItemStats(a);
  const sectionLabels = stats.bySection ? (stats.items[0]?.sections ?? []).map((section) => section.label) : [];
  const header = [...QUESTION_CSV_COLUMNS, ...sectionLabels.map((label) => `% missed: ${label}`)];
  const rows = stats.items.map((s) => [
    s.item.label,
    s.item.groupLabel,
    s.item.prompt,
    formatPoints(s.item.pointsCenti),
    String(s.judged),
    String(s.correct),
    String(s.partly),
    String(s.wrong),
    String(s.blank),
    String(s.unreadable),
    s.judged > 0 ? formatPercent(s.correctTenths) : "",
    s.judged > 0 ? formatPercent(s.missedTenths) : "",
    s.judged > 0 ? formatPoints(roundedAverage(s.earnedCenti, s.judged)) : "",
    s.judged > 0 ? formatPercent(s.earnedTenths) : "",
    s.highlighted ? "yes" : "",
    ...s.sections.map((section) => (section.judged > 0 ? formatPercent(section.missedTenths) : "")),
  ]);
  return { filename: `${slugify(a.title)}-questions.csv`, csv: toCsv([header, ...rows]) };
}

function roundedAverage(totalCenti: number, count: number): number {
  return Math.round(totalCenti / count);
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

export { estimateCostUsd };
