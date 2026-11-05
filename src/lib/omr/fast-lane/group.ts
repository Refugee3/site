import { formatPageRanges } from "@/lib/scan-layout";

// The fast lane's split (pure): which scanned pages make up each student's paper, from the blank worksheet page each one
// matched. A paper starts at every page that matches blank page 1; a page that matches page j > 1 joins the paper being
// built. Two pages that both match page 1 are never one paper. Pages that match nothing (blank backs, covers, another
// worksheet) belong to no paper and are reported. Anything unusual — a missing page, pages out of order, a page that is
// page j again, a paper that starts without page 1, a first page without a name, a page that looked like two worksheet
// pages — is written in the paper's notes, which flag it ("Check the paper's pages").

export interface MatchedPage {
  /** 1-based page of the scan. */
  page: number;
  /** 1-based page of the blank worksheet it matched, or null. */
  blankPage: number | null;
  /** The match looked like more than one worksheet page. */
  ambiguous: boolean;
  /** The page has (almost) no ink. */
  blank: boolean;
  /**
   * Page 1 only: something is written in the name spot (or the top of the page, without one); null when not measured.
   */
  nameInk: boolean | null;
}

export interface GroupedPaper {
  /** In worksheet order (blank page 1 first); scan pages may be out of order when the stack was. */
  pages: Array<{ scanPage: number; blankPage: number }>;
  /** Blank pages that no scan page of this paper matched. */
  missing: number[];
  /** Why the teacher should check where the paper starts or ends; empty when it is clean. */
  notes: string[];
}

export interface Grouping {
  papers: GroupedPaper[];
  /** Scan pages in no paper: blank pages, and pages that matched no worksheet page. */
  skipped: Array<{ page: number; reason: "blank" | "other" }>;
  /** Pages with ink that matched a worksheet page, of all pages with ink (1 when there is no page with ink). */
  matchedShare: number;
}

export const GROUP_NOTES = {
  missing: (pages: number[]) => `Worksheet ${pages.length === 1 ? "page" : "pages"} ${formatPageRanges(pages)} of this paper `
    + `${pages.length === 1 ? "wasn't" : "weren't"} found in the scan; check whether ${pages.length === 1 ? "it is" : "they are"} missing.`,
  noFirstPage: (scanPage: number, blankPage: number) => `This paper starts at scan page ${scanPage}, which is worksheet page ${blankPage}: `
    + "its first page wasn't found just before it.",
  repeated: (scanPage: number, blankPage: number) => `Scan page ${scanPage} is worksheet page ${blankPage} again, so it was taken as `
    + "the start of another paper.",
  outOfOrder: (scanPage: number, blankPage: number) => `Scan page ${scanPage} (worksheet page ${blankPage}) is out of order in the scan.`,
  noName: (scanPage: number) => `Nothing is written where the name goes on scan page ${scanPage}, but it is the worksheet's first `
    + "page, so it starts a new paper.",
  ambiguous: (scanPage: number) => `Scan page ${scanPage} looked like more than one page of the worksheet.`,
  unmatchedNearby: (pages: number[]) => `Scan ${pages.length === 1 ? "page" : "pages"} ${formatPageRanges(pages)} next to this paper `
    + `matched no page of the blank worksheet; check whether ${pages.length === 1 ? "it belongs" : "they belong"} to it.`,
} as const;

/** Groups the scan's pages (in scan order) into papers of a `k`-page worksheet. */
export function groupPages(pages: MatchedPage[], k: number): Grouping {
  const papers: Array<GroupedPaper & { lastBlankPage: number; lastIndex: number }> = [];
  const skipped: Grouping["skipped"] = [];
  let current: (typeof papers)[number] | null = null;
  const start = (p: MatchedPage, blankPage: number, notes: string[]) => {
    current = { pages: [{ scanPage: p.page, blankPage }], missing: [], notes, lastBlankPage: blankPage, lastIndex: p.page };
    papers.push(current);
  };

  for (const p of pages) {
    if (p.blankPage === null || p.blankPage < 1 || p.blankPage > k) {
      skipped.push({ page: p.page, reason: p.blank ? "blank" : "other" });
      continue;
    }
    const j = p.blankPage;
    const open = current as (typeof papers)[number] | null;
    if (j === 1) {
      start(p, 1, p.nameInk === false ? [GROUP_NOTES.noName(p.page)] : []);
    } else if (open === null) {
      start(p, j, [GROUP_NOTES.noFirstPage(p.page, j)]);
    } else if (open.pages.some((x) => x.blankPage === j)) {
      // Never two copies of a page in one paper: the start of another paper whose first page is missing.
      addNote(open, GROUP_NOTES.repeated(p.page, j));
      start(p, j, [GROUP_NOTES.repeated(p.page, j), GROUP_NOTES.noFirstPage(p.page, j)]);
    } else {
      if (j < open.lastBlankPage) addNote(open, GROUP_NOTES.outOfOrder(p.page, j));
      open.pages.push({ scanPage: p.page, blankPage: j });
      open.lastBlankPage = Math.max(open.lastBlankPage, j);
      open.lastIndex = p.page;
    }
    if (p.ambiguous) addNote(current!, GROUP_NOTES.ambiguous(p.page));
  }

  // Missing pages, and pages with ink that matched nothing right after an incomplete paper (or inside it).
  const otherPages = new Set(skipped.filter((s) => s.reason === "other").map((s) => s.page));
  papers.forEach((paper, i) => {
    paper.pages.sort((a, b) => a.blankPage - b.blankPage);
    const present = new Set(paper.pages.map((x) => x.blankPage));
    paper.missing = Array.from({ length: k }, (_, n) => n + 1).filter((n) => !present.has(n));
    if (paper.missing.length > 0) {
      addNote(paper, GROUP_NOTES.missing(paper.missing));
      const first = Math.min(...paper.pages.map((x) => x.scanPage));
      const end = papers[i + 1] ? Math.min(...papers[i + 1].pages.map((x) => x.scanPage)) : Infinity;
      const nearby = [...otherPages].filter((page) => page > first && page < end).sort((a, b) => a - b);
      if (nearby.length > 0) addNote(paper, GROUP_NOTES.unmatchedNearby(nearby));
    }
  });

  const inked = pages.filter((p) => !p.blank);
  const matched = inked.filter((p) => p.blankPage !== null).length;
  return {
    papers: papers.map(({ pages: ps, missing, notes }) => ({ pages: ps, missing, notes })),
    skipped,
    matchedShare: inked.length === 0 ? 1 : matched / inked.length,
  };
}

function addNote(paper: { notes: string[] }, note: string): void {
  if (!paper.notes.includes(note)) paper.notes.push(note);
}

/** The scan pages of a paper, in worksheet order. */
export function scanPagesOf(paper: GroupedPaper): number[] {
  return paper.pages.map((p) => p.scanPage);
}
