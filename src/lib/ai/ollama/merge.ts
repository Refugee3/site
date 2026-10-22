import type { ScanPreviousPage } from "../grader";
import type { KeyExtraction, ReadingItem, ReadingOutput, ScanPages } from "../schemas";

// A local model sees a few page images per call (OLLAMA_PAGES_PER_CALL), so long keys, papers and scan chunks are read in
// page batches and the answers merged here. Kept deliberately simple:
// - answer key: the items of every batch in page order; the first title and stated total; notes and questions of all.
// - paper (its blind reading): per ref, the reading from the batch where the student did the most (complete > partial >
//   none), then the one with writing, then the most confident, then the earliest; the name from the first batch that found one.
// - scan chunk: the pages of every batch, renumbered to the chunk.

/** Consecutive page ranges of at most `size` pages: [[1, 4], [5, 8], [9, 9]] for 9 pages in fours. 1-based, inclusive. */
export function pageBatches(pageCount: number, size: number): Array<[number, number]> {
  const per = Math.max(1, Math.floor(size));
  const batches: Array<[number, number]> = [];
  for (let first = 1; first <= pageCount; first += per) batches.push([first, Math.min(pageCount, first + per - 1)]);
  return batches;
}

export function mergeKeyExtractions(parts: KeyExtraction[]): KeyExtraction {
  if (parts.length === 1) return parts[0];
  const kinds = parts.map((p) => p.document_kind);
  const documentKind = kinds.includes("answer_key") ? "answer_key" : kinds.includes("blank_worksheet") ? "blank_worksheet" : kinds[0];
  return {
    document_kind: documentKind,
    items: parts.flatMap((p) => p.items),
    stated_total_points: parts.find((p) => p.stated_total_points !== null)?.stated_total_points ?? null,
    notes: uniqueJoin(parts.map((p) => p.notes)),
    // Question ids only need to be unique within one reading.
    questions_for_teacher: parts.flatMap((p, i) => p.questions_for_teacher.map((q) => ({ ...q, id: `b${i + 1}-${q.id}` }))),
    suggested_title: parts.find((p) => p.suggested_title !== null)?.suggested_title ?? null,
  };
}

interface WithRefs<I extends { ref: string }> {
  items: I[];
}

/**
 * The output's items limited to the known refs, the first entry of each, in ref order. Refs the model left out stay out:
 * reconcileGrading flags them (and asks for a retry when most are missing).
 */
export function itemsInRefOrder<I extends { ref: string }, T extends WithRefs<I>>(output: T, refs: string[]): T {
  const byRef = new Map<string, I>();
  for (const item of output.items) {
    const ref = item.ref.trim().replace(/^\[|\]$/g, "").toUpperCase();
    if (refs.includes(ref) && !byRef.has(ref)) byRef.set(ref, { ...item, ref });
  }
  return { ...output, items: refs.flatMap((ref) => byRef.get(ref) ?? []) };
}

/** What an answer about one paper must fix: one entry per ref, in this order. */
export function refProblems(output: WithRefs<{ ref: string }>, refs: string[]): string[] {
  const got = output.items.map((item) => item.ref);
  if (got.length === refs.length && got.every((ref, i) => ref === refs[i])) return [];
  const missing = refs.filter((ref) => !got.includes(ref));
  const extra = got.filter((ref) => !refs.includes(ref));
  return [
    refs.length === 0 ? "items must be empty" : `items must have exactly ${refs.length} entries, with ref ${refs[0]} to ${refs.at(-1)} in this order`,
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ...(extra.length > 0 ? [`not in the key: ${extra.join(", ")}`] : []),
  ];
}

const ATTEMPT_RANK = { complete: 2, partial: 1, none: 0 } as const;
const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 } as const;

/** Merges the blind readings of one paper's page batches (each already in ref order) into one reading. */
export function mergeReadings(parts: ReadingOutput[], refs: string[]): ReadingOutput {
  if (parts.length === 1) return parts[0];
  const items = refs.flatMap((ref) => {
    const candidates = parts.flatMap((p) => p.items.filter((item) => item.ref === ref));
    if (candidates.length === 0) return [];
    // Stable: the earliest batch wins a tie.
    return [candidates.reduce((best, item) => (rank(item) > rank(best) ? item : best))];
  });
  const named = parts.find((p) => p.student.name !== null) ?? parts[0];
  return {
    student: { ...named.student, multiple_students_detected: parts.some((p) => p.student.multiple_students_detected) },
    document_check: {
      match: parts[0].document_check.match,
      pages_appear_missing: parts.some((p) => p.document_check.pages_appear_missing),
      note: uniqueJoin(parts.map((p) => p.document_check.note)),
    },
    items,
    integrity: {
      grader_directed_text_found: parts.some((p) => p.integrity.grader_directed_text_found),
      excerpt: uniqueJoin(parts.map((p) => p.integrity.excerpt)),
    },
    unmatched_work: uniqueJoin(parts.map((p) => p.unmatched_work)),
  };
}

function rank(item: ReadingItem): number {
  return ATTEMPT_RANK[item.attempt] * 100 + (item.legibility === "no_writing" ? 0 : 10) + CONFIDENCE_RANK[item.reading_confidence];
}

/**
 * The scan pages of one batch, cut to its `count` pages and renumbered to the chunk (`offset` = pages before the batch).
 * Missing pages stay missing; normalizeScanReadings marks them unread.
 */
export function offsetScanPages(output: ScanPages, count: number, offset: number): ScanPages["pages"] {
  const seen = new Set<number>();
  return output.pages
    .map((page) => ({ ...page, chunk_page: Math.round(page.chunk_page) }))
    .filter((page) => page.chunk_page >= 1 && page.chunk_page <= count && !seen.has(page.chunk_page) && seen.add(page.chunk_page))
    .sort((a, b) => a.chunk_page - b.chunk_page)
    .map((page) => ({ ...page, chunk_page: page.chunk_page + offset }));
}

/** What the scan reading of one batch must fix: chunk_page 1…count, in order. */
export function scanPageProblems(output: ScanPages, count: number): string[] {
  const ok = output.pages.length === count && output.pages.every((page, i) => page.chunk_page === i + 1);
  return ok ? [] : [`pages must have exactly ${count} entries, with chunk_page 1 to ${count} in this order`];
}

/** How the last page read so far was described, for the next batch (as the job does between chunks). */
export function previousFrom(pages: ScanPages["pages"], firstPage: number): ScanPreviousPage | null {
  const last = pages.at(-1);
  if (!last) return null;
  return {
    page: firstPage + last.chunk_page - 1,
    kind: last.kind,
    studentName: last.student_name,
    worksheetPage: last.worksheet_page === null ? null : Math.round(last.worksheet_page),
    pageMarker: last.page_marker,
  };
}

function uniqueJoin(texts: string[]): string {
  return [...new Set(texts.map((t) => t.trim()).filter((t) => t !== ""))].join(" ");
}
