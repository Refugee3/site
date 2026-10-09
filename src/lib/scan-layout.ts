import { cleanName, nameKey } from "@/lib/grading/names";
import type { ScanLayout, ScanPageReading, ScanStatus } from "@/lib/types";

// The teacher's view of a split scan: which pages form which paper, and what to double-check.
// Pure and client-safe: the scan review screen edits layouts with these functions.

export type ScanPaperFlag = "low_confidence" | "page_count" | "no_name" | "several_names" | "unread_pages" | "too_many_pages";

export interface ProposedPaper {
  /** 1-based. */
  index: number;
  /** 1-based scan pages, ascending. */
  pages: number[];
  name: string | null;
  section: string | null;
  flags: ScanPaperFlag[];
}

export const SCAN_STATUS_LABEL: Record<ScanStatus, string> = {
  splitting: "Being split…",
  review: "Ready to check",
  creating: "Creating papers…",
  done: "Papers created",
  failed: "Couldn't be split",
};

/** The kept pages (1-based) grouped into papers: a paper starts at the first kept page and at every kept page marked as a start. */
export function papersFromLayout(layout: ScanLayout): number[][] {
  const papers: number[][] = [];
  layout.forEach((page, i) => {
    if (page.dropped) return;
    if (papers.length === 0 || page.startsPaper) papers.push([]);
    papers[papers.length - 1].push(i + 1);
  });
  return papers;
}

/** A new paper every `n` pages, nothing left out. */
export function everyNLayout(pageCount: number, n: number): ScanLayout {
  return Array.from({ length: pageCount }, (_, i) => ({ startsPaper: i % n === 0, dropped: false }));
}

/** The most common paper length; a tie goes to the key's page count when it is among the tied lengths, else to the smallest. */
export function expectedPagesPerPaper(lengths: number[], keyPageCount: number | null): number | null {
  if (lengths.length === 0) return keyPageCount;
  const counts = new Map<number, number>();
  for (const length of lengths) counts.set(length, (counts.get(length) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const tied = [...counts.keys()].filter((length) => counts.get(length) === top);
  return keyPageCount !== null && tied.includes(keyPageCount) ? keyPageCount : Math.min(...tied);
}

/**
 * The papers of a layout with what the AI read on their pages. Names, several-names and unread-page
 * flags need readings, so a scan split every N pages without an AI run shows none of them.
 */
export function describePapers(
  layout: ScanLayout,
  readings: Array<ScanPageReading | null>,
  o: { keyPageCount: number | null; maxPagesPerPaper: number },
): ProposedPaper[] {
  const papers = papersFromLayout(layout);
  const expected = expectedPagesPerPaper(papers.map((pages) => pages.length), o.keyPageCount);
  const read = readings.length > 0;
  return papers.map((pages, i) => {
    const pageReadings = pages.map((page) => readings[page - 1] ?? null);
    const names = pageReadings.flatMap((r) => {
      const name = cleanName(r?.studentName ?? null);
      return name === null ? [] : [name];
    });
    const nameKeys = new Set(names.flatMap((name) => nameKey(name) ?? []));
    const flags: ScanPaperFlag[] = [];
    if (pageReadings.some((r) => r?.confidence === "low")) flags.push("low_confidence");
    if (expected !== null && pages.length !== expected) flags.push("page_count");
    if (read && names.length === 0) flags.push("no_name");
    if (read && nameKeys.size >= 2) flags.push("several_names");
    if (read && pageReadings.some((r) => r === null || !r.reported)) flags.push("unread_pages");
    if (pages.length > o.maxPagesPerPaper) flags.push("too_many_pages");
    return {
      index: i + 1,
      pages,
      name: names[0] ?? null,
      section: pageReadings.find((r) => r?.sectionRaw)?.sectionRaw ?? null,
      flags,
    };
  });
}

/**
 * The name in a paper's heading. A scan the AI never read (split every N pages) has no names yet: they are read when
 * each paper is graded, so it shows none rather than "No name found" (null).
 */
export function paperNameLabel(paper: Pick<ProposedPaper, "name">, namesRead: boolean): string | null {
  return paper.name ?? (namesRead ? "No name found" : null);
}

/** The AI's own split of the scan, if it made one: a scan split every N pages without an AI run has none. */
export function aiProposedLayout(scan: { readings: unknown[]; proposedLayout: ScanLayout | null }): ScanLayout | null {
  return scan.readings.length > 0 ? scan.proposedLayout : null;
}

/** Marks or unmarks a page as the start of a paper; a left-out page stays as it is. */
export function toggleStart(layout: ScanLayout, index: number): ScanLayout {
  return layout.map((page, i) => (i === index && !page.dropped ? { ...page, startsPaper: !page.startsPaper } : page));
}

/**
 * Leaves a page out or puts it back. Leaving out a page that starts a paper moves the start to the next
 * kept page, so the paper itself stays; a page put back continues the paper before it.
 */
export function toggleDropped(layout: ScanLayout, index: number): ScanLayout {
  const page = layout[index];
  if (page.dropped) return layout.map((p, i) => (i === index ? { startsPaper: false, dropped: false } : p));
  const nextKept = page.startsPaper ? layout.findIndex((p, i) => i > index && !p.dropped) : -1;
  return layout.map((p, i) => {
    if (i === index) return { startsPaper: false, dropped: true };
    if (i === nextKept) return { ...p, startsPaper: true };
    return p;
  });
}

/** Why a page is left out: what the AI saw on it, or the teacher's choice. */
export function droppedReason(reading: ScanPageReading | null): "blank" | "cover" | "answer_key" | "teacher" {
  switch (reading?.kind) {
    case "blank":
      return "blank";
    case "cover_or_separator":
      return "cover";
    case "answer_key":
      return "answer_key";
    default:
      return "teacher";
  }
}

/** Ascending pages as ranges: [1, 2, 3, 5] → "1–3, 5". */
export function formatPageRanges(pages: number[]): string {
  const ranges: string[] = [];
  let start = 0;
  for (let i = 1; i <= pages.length; i++) {
    if (i < pages.length && pages[i] === pages[i - 1] + 1) continue;
    ranges.push(i - 1 === start ? String(pages[start]) : `${pages[start]}–${pages[i - 1]}`);
    start = i;
  }
  return ranges.join(", ");
}

export function sameLayout(a: ScanLayout | null, b: ScanLayout | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((page, i) => page.startsPaper === b[i].startsPaper && page.dropped === b[i].dropped);
}
