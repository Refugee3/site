import { AiError } from "@/lib/ai/errors";
import type { GradingOutput, PacketOutput, PacketPaper } from "@/lib/ai/schemas";
import { formatPageRanges } from "@/lib/scan-layout";
import type { AiUsage, OnePassProgress, SkippedPage, SkippedPageReason } from "@/lib/types";

// Grading a whole-class scan in one pass: the scan is read in chunks of consecutive pages, in order, and the AI finds and
// grades the papers of each chunk in the same call. This module plans the chunks and turns the AI's answer for one chunk
// into the papers to store and the page the next chunk starts on. Pure: no database, no AI.

/**
 * Pages per chunk: whole papers when the key tells a paper's length k and one fits (floor(max / k) × k), else `maxPages`.
 * `override` lowers the maximum after a chunk turned out too large for the AI's answer.
 */
export function chunkPageCount(o: { keyPageCount: number | null; maxPages: number; override?: number | null }): number {
  const max = Math.max(1, Math.min(o.maxPages, o.override ?? o.maxPages));
  const k = o.keyPageCount;
  if (k === null || k < 1 || k > max) return max;
  return Math.floor(max / k) * k;
}

/** The pages of the chunk that starts at `nextPage` (1-based), at most `size` long; null once every page was read. */
export function planChunk(nextPage: number, totalPages: number, size: number): { firstPage: number; lastPage: number } | null {
  if (nextPage > totalPages) return null;
  return { firstPage: nextPage, lastPage: Math.min(totalPages, nextPage + Math.max(1, size) - 1) };
}

/** About half of `pages`, in whole papers of k pages while more than one fits; null when it is already one page. */
export function smallerChunk(pages: number, keyPageCount: number | null): number | null {
  if (pages <= 1) return null;
  const k = keyPageCount;
  if (k !== null && k >= 1 && pages > k) return Math.max(k, Math.floor(pages / 2 / k) * k);
  return Math.ceil(pages / 2);
}

export interface ChunkContext {
  /** The chunk's pages in the scan, 1-based. */
  firstPage: number;
  lastPage: number;
  totalPages: number;
  /** The chunk before this one ended where a paper ends (true for the first chunk). */
  previousEndedCleanly: boolean;
}

export interface ChunkPaper {
  /** Scan pages, 1-based. */
  firstPage: number;
  lastPage: number;
  /** The paper's grading, its item pages counted from the paper's first page (as for a paper uploaded on its own). */
  output: GradingOutput;
  /** Why the teacher should check where the paper starts or ends (the paper_boundary flag); empty when nothing is unsure. */
  boundaryNotes: string[];
}

export interface InterpretedChunk {
  /** In page order. */
  papers: ChunkPaper[];
  /** Pages before `nextPage` that belong to no paper. */
  skipped: SkippedPage[];
  /** Where the next chunk starts; totalPages + 1 after the last chunk. */
  nextPage: number;
  /** The chunk ends where a paper ends, so the next chunk starts with a new paper. */
  endedCleanly: boolean;
  /** The AI's last paper may go on after the chunk: it was dropped, and the next chunk starts on its first page. */
  carriedOver: boolean;
}

export const BOUNDARY_NOTES = {
  lowConfidence: "The AI wasn't sure where this paper starts or ends in the scan.",
  overlap: "The AI put some of these pages in two papers; check where this paper starts and ends.",
  tooLong: (lastPage: number, chunkPages: number) => `This paper may go on after scan page ${lastPage}, but the AI reads at most `
    + `${chunkPages} pages at a time: any later pages were graded as a paper of their own.`,
  continues: (firstPage: number) => `The AI thought this paper may continue one that starts before scan page ${firstPage}.`,
  restOfLongPaper: (firstPage: number) => `This looks like the rest of the paper before scan page ${firstPage}, which was too long to `
    + "read in one go; it was graded on its own.",
  unassigned: (pages: number[]) => `Scan ${pages.length === 1 ? "page" : "pages"} ${formatPageRanges(pages)} ${pages.length === 1 ? "is" : "are"} `
    + "in no paper; check whether it belongs to this one.",
} as const;

interface Candidate {
  paper: PacketPaper;
  /** Chunk pages, 1-based. */
  first: number;
  last: number;
  notes: string[];
}

/**
 * The papers of one chunk, from the AI's answer. Page numbers are rounded and clamped to the chunk, papers sorted, and
 * overlaps cut (a paper inside the one before it is dropped). Then:
 * - Carry-over: when the last paper may go on after the chunk (and the chunk is not the scan's last), it is dropped and the
 *   next chunk starts on its first page, so it is read again whole. When it is the chunk's only paper and starts on the
 *   chunk's first page, that would make no progress: it is kept, flagged, and the chunk does not end cleanly.
 * - Trailing pages in no paper and not skipped are read again at the start of the next chunk (when that still makes progress).
 * - A first paper the AI says continues from before the chunk is flagged: after a clean end it may be misread; after an
 *   unclean one it is the rest of the long paper.
 * - Low boundary confidence and overlaps are flagged; a page in no paper is reported as skipped (`unassigned` when the AI
 *   gave no reason) and flags the paper before it (else the one after).
 * Throws a retryable `invalid_output` when the answer accounts for fewer than half of the chunk's pages.
 */
export function interpretChunk(output: PacketOutput, c: ChunkContext): InterpretedChunk {
  const n = c.lastPage - c.firstPage + 1;
  const scanPage = (chunkPage: number) => c.firstPage + chunkPage - 1;
  const clamp = (page: number) => Math.min(Math.max(Math.round(page), 1), n);
  const isLastChunk = c.lastPage >= c.totalPages;

  const sorted: Candidate[] = output.papers
    .map((paper) => {
      const a = clamp(paper.first_page);
      const b = clamp(paper.last_page);
      return { paper, first: Math.min(a, b), last: Math.max(a, b), notes: [] };
    })
    .sort((x, y) => x.first - y.first || x.last - y.last);
  const papers: Candidate[] = [];
  for (const candidate of sorted) {
    const prev = papers.at(-1);
    if (prev && candidate.first <= prev.last) {
      addNote(prev, BOUNDARY_NOTES.overlap);
      if (candidate.last <= prev.last) continue;
      candidate.first = prev.last + 1;
      addNote(candidate, BOUNDARY_NOTES.overlap);
    }
    papers.push(candidate);
  }

  const inPaper = new Array<boolean>(n + 1).fill(false);
  for (const p of papers) for (let page = p.first; page <= p.last; page++) inPaper[page] = true;
  const skippedByAi = new Map<number, SkippedPageReason>();
  for (const s of output.skipped_pages) {
    const page = Math.round(s.page);
    if (page >= 1 && page <= n && !inPaper[page] && !skippedByAi.has(page)) skippedByAi.set(page, s.kind);
  }
  const accounted = inPaper.filter(Boolean).length + skippedByAi.size;
  if (accounted < Math.ceil(n / 2)) {
    throw new AiError("invalid_output", "The AI accounted for too few of the scanned pages.", { retryable: true });
  }

  let nextChunkPage = n + 1;
  let endedCleanly = true;
  let carriedOver = false;
  const last = papers.at(-1);
  if (!isLastChunk && last?.paper.may_continue_after_chunk) {
    if (last.first > 1) {
      papers.pop();
      nextChunkPage = last.first;
      carriedOver = true;
    } else {
      addNote(last, BOUNDARY_NOTES.tooLong(scanPage(n), n));
      endedCleanly = false;
    }
  } else if (!isLastChunk) {
    let end = n;
    while (end >= 1 && !inPaper[end] && !skippedByAi.has(end)) end--;
    if (end >= 1 && end < n) nextChunkPage = end + 1;
  }

  const first = papers[0];
  if (first && c.firstPage > 1 && first.paper.continues_from_previous_chunk) {
    addNote(first, c.previousEndedCleanly ? BOUNDARY_NOTES.continues(scanPage(first.first)) : BOUNDARY_NOTES.restOfLongPaper(scanPage(first.first)));
  }
  for (const p of papers) if (p.paper.boundary_confidence === "low") addNote(p, BOUNDARY_NOTES.lowConfidence);

  const skipped: SkippedPage[] = [];
  const unassignedBy = new Map<Candidate, number[]>();
  for (let page = 1; page < nextChunkPage; page++) {
    if (inPaper[page]) continue;
    const reason = skippedByAi.get(page) ?? "unassigned";
    skipped.push({ page: scanPage(page), reason });
    if (reason !== "unassigned") continue;
    const owner = papers.findLast((p) => p.last < page) ?? papers.find((p) => p.first > page);
    if (owner) unassignedBy.set(owner, [...(unassignedBy.get(owner) ?? []), scanPage(page)]);
  }
  for (const [owner, pages] of unassignedBy) addNote(owner, BOUNDARY_NOTES.unassigned(pages));

  return {
    papers: papers.map((p) => ({
      firstPage: scanPage(p.first),
      lastPage: scanPage(p.last),
      output: paperGrading(p.paper, p.first),
      boundaryNotes: p.notes,
    })),
    skipped,
    nextPage: scanPage(nextChunkPage),
    endedCleanly,
    carriedOver,
  };
}

function addNote(c: Candidate, note: string): void {
  if (!c.notes.includes(note)) c.notes.push(note);
}

/** One paper's grading as for a paper of its own: item pages counted from `firstChunkPage`, the paper's first page. */
function paperGrading(paper: PacketPaper, firstChunkPage: number): GradingOutput {
  return {
    student: paper.student,
    document_check: paper.document_check,
    items: paper.items.map((item) => ({ ...item, pages: item.pages.map((page) => page - firstChunkPage + 1) })),
    integrity: paper.integrity,
    unmatched_work: paper.unmatched_work,
    overall_feedback: paper.overall_feedback,
    teacher_summary: paper.teacher_summary,
  };
}

/**
 * One AI call's usage shared among `parts` papers: each field split evenly, the remainder going to the first papers, so the
 * shares add up to the call. An empty list for no parts.
 */
export function splitUsage(u: AiUsage, parts: number): AiUsage[] {
  const share = (total: number, i: number) => Math.floor(total / parts) + (i < total % parts ? 1 : 0);
  return Array.from({ length: Math.max(0, parts) }, (_, i) => ({
    inputTokens: share(u.inputTokens, i),
    outputTokens: share(u.outputTokens, i),
    cacheReadTokens: share(u.cacheReadTokens, i),
    cacheWriteTokens: share(u.cacheWriteTokens, i),
  }));
}

/** Anything was graded or answered: the scan can no longer be split another way without grading pages twice. */
export function hasOnePassProgress(p: OnePassProgress | null): boolean {
  return p !== null && (p.chunks > 0 || p.pending !== null || p.papers.length > 0);
}
