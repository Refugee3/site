import { UNNAMED_SORT_KEY } from "@/lib/grading/names";
import { SUBMISSION_STATUSES, type BoardFilter, type Section, type StatusCounts, type Submission, type SubmissionStatus } from "@/lib/types";

export interface BoardGroup {
  key: string;
  label: string;
  rows: Array<{ current: Submission; earlier: Submission[] /* newest first */ }>;
}

type BoardRow = BoardGroup["rows"][number];

const NO_SECTION = { key: "none", label: "No section" } as const;

/**
 * Groups papers for the board: configured sections in order (or, without sections, the
 * spellings students wrote), then "No section"; within a group by surname, then submission time.
 * A student's earlier attempts (same full name, same section) are folded under their newest paper.
 * Empty groups are dropped.
 */
export function organizeBoard(submissions: Submission[], sections: Section[]): BoardGroup[] {
  const rows = collapseResubmissions(submissions);
  const groups = sections.length > 0 ? groupBySection(rows, sections) : groupBySectionKey(rows);
  for (const group of groups) group.rows.sort(compareRows);
  return groups.filter((group) => group.rows.length > 0);
}

/**
 * The statuses each board filter shows (`all`: every current paper). The one definition behind both
 * the filter chips' counts and the rows they show, so a chip never counts papers its filter hides.
 */
export const BOARD_FILTER_STATUSES: Record<BoardFilter, readonly SubmissionStatus[] | null> = {
  all: null,
  needs_review: ["needs_review"],
  in_progress: ["queued", "grading"],
  failed: ["failed"],
  graded: ["graded"],
};

export function inBoardFilter(filter: BoardFilter, status: SubmissionStatus): boolean {
  const statuses = BOARD_FILTER_STATUSES[filter];
  return statuses === null || statuses.includes(status);
}

/** How many current papers a filter shows, from counts made by countCurrent. */
export function boardFilterCount(filter: BoardFilter, counts: StatusCounts): number {
  const statuses = BOARD_FILTER_STATUSES[filter];
  return statuses === null ? counts.total : statuses.reduce((sum, status) => sum + counts[status], 0);
}

/** Status counts of the current papers only: an earlier attempt folded under a newer one is not counted. */
export function countCurrent(groups: BoardGroup[]): StatusCounts {
  const counts = Object.fromEntries(SUBMISSION_STATUSES.map((status) => [status, 0])) as StatusCounts;
  counts.total = 0;
  for (const group of groups) {
    for (const { current } of group.rows) {
      counts[current.status]++;
      counts.total++;
    }
  }
  return counts;
}

/** Ids of the current papers in board order. */
export function boardOrderIds(groups: BoardGroup[]): string[] {
  return groups.flatMap((group) => group.rows.map((row) => row.current.id));
}

/** The next current paper after `afterId` (wrapping around) that needs review; never `afterId` itself. */
export function nextNeedsReview(groups: BoardGroup[], afterId: string): string | null {
  const rows = groups.flatMap((group) => group.rows);
  // An earlier attempt has no row of its own, so it stands at the position of its newest attempt.
  const start = rows.findIndex((row) => row.current.id === afterId || row.earlier.some((s) => s.id === afterId));
  for (let step = 1; step <= rows.length; step++) {
    const candidate = rows[(start + step) % rows.length].current;
    if (candidate.status === "needs_review" && candidate.id !== afterId) return candidate.id;
  }
  return null;
}

/**
 * Papers by the same student in the same section collapse into one row. Without student accounts the
 * written name is the only signal, so only a name of at least two words identifies a student: two
 * children in one class who both write just "Maria" stay two rows (and two CSV rows). Unnamed papers
 * never merge either.
 */
function collapseResubmissions(submissions: Submission[]): BoardRow[] {
  const rows: BoardRow[] = [];
  const attemptsByIdentity = new Map<string, Submission[]>();
  for (const submission of submissions) {
    if (!identifiesStudent(submission.nameKey)) {
      rows.push({ current: submission, earlier: [] });
      continue;
    }
    const identity = `${identityGroupKey(submission)}|${submission.nameKey}`;
    const attempts = attemptsByIdentity.get(identity);
    if (attempts) attempts.push(submission);
    else attemptsByIdentity.set(identity, [submission]);
  }
  for (const attempts of attemptsByIdentity.values()) {
    const [current, ...earlier] = attempts.sort(newestFirst);
    rows.push({ current, earlier });
  }
  return rows;
}

/** A name key of two or more words (nameKey joins its words with single spaces). */
function identifiesStudent(nameKey: string | null): nameKey is string {
  return nameKey !== null && nameKey.includes(" ");
}

function identityGroupKey(s: Submission): string {
  return s.sectionId ?? (s.sectionKey ? `k:${s.sectionKey}` : "none");
}

function groupBySection(rows: BoardRow[], sections: Section[]): BoardGroup[] {
  const ordered = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const bySection = new Map(ordered.map((section): [string, BoardGroup] => [section.id, { key: section.id, label: section.label, rows: [] }]));
  const unsectioned: BoardGroup = { ...NO_SECTION, rows: [] };
  for (const row of rows) (bySection.get(row.current.sectionId ?? "") ?? unsectioned).rows.push(row);
  return [...bySection.values(), unsectioned];
}

/** Without configured sections, papers group by the canonical form of what students wrote. */
function groupBySectionKey(rows: BoardRow[]): BoardGroup[] {
  const byKey = new Map<string, BoardRow[]>();
  const unsectioned: BoardGroup = { ...NO_SECTION, rows: [] };
  for (const row of rows) {
    const sectionKey = row.current.sectionKey;
    if (sectionKey === null) {
      unsectioned.rows.push(row);
      continue;
    }
    const keyed = byKey.get(sectionKey);
    if (keyed) keyed.push(row);
    else byKey.set(sectionKey, [row]);
  }
  const keyedGroups = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([sectionKey, groupRows]): BoardGroup => ({
      key: `k:${sectionKey}`,
      label: mostCommonSpelling(groupRows) ?? sectionKey,
      rows: groupRows,
    }));
  return [...keyedGroups, unsectioned];
}

/** The section spelling students used most often in a group (ties go to the alphabetically first). */
function mostCommonSpelling(rows: BoardRow[]): string | null {
  const counts = new Map<string, number>();
  for (const { current } of rows) {
    if (current.aiSectionRaw !== null) counts.set(current.aiSectionRaw, (counts.get(current.aiSectionRaw) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(([a, countA], [b, countB]) => countB - countA || compareStrings(a, b));
  return ranked.length > 0 ? ranked[0][0] : null;
}

function compareRows(a: BoardRow, b: BoardRow): number {
  const x = a.current;
  const y = b.current;
  return compareNameSortKeys(x.nameSortKey, y.nameSortKey) || x.createdAt - y.createdAt || compareStrings(x.id, y.id);
}

function compareNameSortKeys(a: string, b: string): number {
  const aUnnamed = a === UNNAMED_SORT_KEY;
  const bUnnamed = b === UNNAMED_SORT_KEY;
  if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
  return compareStrings(a, b);
}

function newestFirst(a: Submission, b: Submission): number {
  return b.createdAt - a.createdAt || compareStrings(b.id, a.id);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
