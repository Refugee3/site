import { UNNAMED_SORT_KEY } from "@/lib/grading/names";
import type { Section, Submission } from "@/lib/types";

export interface BoardGroup {
  key: string;
  label: string;
  rows: Array<{ current: Submission; earlier: Submission[] /* newest first */ }>;
}

type BoardRow = BoardGroup["rows"][number];

const NO_SECTION = { key: "none", label: "No section" } as const;

/**
 * Groups papers for the board (§6.6): configured sections in order (or, without sections, the
 * spellings students wrote), then "No section"; within a group by surname, then submission time.
 * A student's earlier attempts are folded under their newest paper. Empty groups are dropped.
 */
export function organizeBoard(submissions: Submission[], sections: Section[]): BoardGroup[] {
  const rows = collapseResubmissions(submissions);
  const groups = sections.length > 0 ? groupBySection(rows, sections) : groupBySectionKey(rows);
  for (const group of groups) group.rows.sort(compareRows);
  return groups.filter((group) => group.rows.length > 0);
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

/** Papers by the same named student in the same section collapse into one row; unnamed papers never merge. */
function collapseResubmissions(submissions: Submission[]): BoardRow[] {
  const rows: BoardRow[] = [];
  const attemptsByIdentity = new Map<string, Submission[]>();
  for (const submission of submissions) {
    if (submission.nameKey === null) {
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
