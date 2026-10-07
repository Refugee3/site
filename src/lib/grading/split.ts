import { AiError } from "@/lib/ai/errors";
import type { ScanPages } from "@/lib/ai/schemas";
import { cleanName, nameKey } from "@/lib/grading/names";
import { truncateChars } from "@/lib/grading/text";
import type { AnswerKey, KeyItem, ScanLayout, ScanPageKind, ScanPageReading } from "@/lib/types";

// Splitting a whole-class scan: the AI describes pages in chunks, this module turns its readings into
// a proposed grouping that the teacher checks before anything is graded.

export const SCAN_CHUNK_MAX_PAGES = 20;
export const SCAN_CHUNK_MAX_BYTES = 20 * 1_048_576; // < PDF_BYTE_BUDGET (22 MiB, claude.ts)

const CAPS = { studentName: 120, sectionRaw: 60, pageMarker: 40, note: 200 } as const;
const DROPPED_KINDS: ReadonlySet<ScanPageKind> = new Set(["blank", "cover_or_separator", "answer_key"]);

/** One reading per chunk page, in order. Pages the AI skipped get a low-confidence placeholder (`reported: false`). */
export function normalizeScanReadings(output: ScanPages, o: { chunkPageCount: number }): ScanPageReading[] {
  const byPage = new Map<number, ScanPages["pages"][number]>();
  for (const page of output.pages) {
    const n = Math.round(page.chunk_page);
    if (n >= 1 && n <= o.chunkPageCount && !byPage.has(n)) byPage.set(n, page);
  }
  if (byPage.size < Math.ceil(o.chunkPageCount / 2)) {
    throw new AiError("invalid_output", "The AI described too few of the scanned pages.", { retryable: true });
  }
  return Array.from({ length: o.chunkPageCount }, (_, i) => {
    const page = byPage.get(i + 1);
    if (!page) return unreadPage();
    const worksheetPage = page.worksheet_page === null ? null : Math.round(page.worksheet_page);
    return {
      kind: page.kind,
      startsNewPaper: page.starts_new_paper,
      studentName: optionalText(page.student_name, CAPS.studentName),
      sectionRaw: optionalText(page.section_raw, CAPS.sectionRaw),
      pageMarker: optionalText(page.page_marker, CAPS.pageMarker),
      worksheetPage: worksheetPage !== null && worksheetPage >= 1 ? worksheetPage : null,
      confidence: page.confidence,
      note: truncateChars(page.note.trim(), CAPS.note),
      reported: true,
    };
  });
}

function unreadPage(): ScanPageReading {
  return {
    kind: "student_work", startsNewPaper: false, studentName: null, sectionRaw: null, pageMarker: null, worksheetPage: null,
    confidence: "low", note: "", reported: false,
  };
}

function optionalText(s: string | null, max: number): string | null {
  const text = truncateChars(s?.trim() ?? "", max);
  return text === "" ? null : text;
}

/** "2 of 3", "2/3" → { page: 2, of: 3 }; a marker with a single number ("p. 2") → { page: 2, of: null }; else null. */
export function parsePageMarker(marker: string | null): { page: number; of: number | null } | null {
  if (marker === null) return null;
  const pair = /(\d+)\s*(?:\/|of)\s*(\d+)/i.exec(marker);
  if (pair) return { page: Number(pair[1]), of: Number(pair[2]) };
  const numbers = marker.match(/\d+/g) ?? [];
  return numbers.length === 1 ? { page: Number(numbers[0]), of: null } : null;
}

/**
 * Groups the readings into papers. Blank, cover and answer-key pages are left out. A confident reading
 * (the model's own start, or high confidence) is always followed; an unsure page starts a new paper when
 * it shows a different name, a first-page marker, a worksheet restart, or (with the key's page count as a
 * hint) when the current paper already has the worksheet's length and nothing says the page continues it.
 */
export function proposeLayout(readings: ScanPageReading[], o: { keyPageCount: number | null }): ScanLayout {
  let prev: ScanPageReading | null = null;
  let currentName: string | null = null;
  let length = 0;
  return readings.map((r) => {
    if (DROPPED_KINDS.has(r.kind)) return { startsPaper: false, dropped: true };
    const name = readingNameKey(r);
    const starts = prev === null || startsPaper(r, prev, { currentName, length, keyPageCount: o.keyPageCount });
    if (starts) {
      currentName = name;
      length = 0;
    } else {
      currentName ??= name;
    }
    length++;
    prev = r;
    return { startsPaper: starts, dropped: false };
  });
}

function startsPaper(
  r: ScanPageReading,
  prev: ScanPageReading,
  paper: { currentName: string | null; length: number; keyPageCount: number | null },
): boolean {
  if (r.startsNewPaper) return true;
  if (r.confidence === "high") return false;
  const name = readingNameKey(r);
  const markerPage = parsePageMarker(r.pageMarker)?.page;
  if (name !== null && paper.currentName !== null && name !== paper.currentName) return true;
  if (markerPage === 1) return true;
  if (r.worksheetPage === 1 && prev.worksheetPage !== null && (markerPage ?? 1) === 1) return true;
  const continues = (markerPage ?? 0) > 1 || (r.worksheetPage ?? 0) > 1 || (name !== null && name === paper.currentName);
  return paper.keyPageCount !== null && paper.length >= paper.keyPageCount && !continues;
}

function readingNameKey(r: ScanPageReading): string | null {
  return nameKey(cleanName(r.studentName));
}

/** How many pages a student's paper usually has: the answer key's page count, else the highest page an item is on. */
export function keyPageCountHint(key: Pick<AnswerKey, "sourcePageCount" | "documentKind">, items: Pick<KeyItem, "page">[]): number | null {
  if (key.documentKind !== "student_work" && key.documentKind !== "unrelated" && key.sourcePageCount) return key.sourcePageCount;
  const pages = items.flatMap((item) => (item.page === null ? [] : [item.page]));
  return pages.length > 0 ? Math.max(...pages) : null;
}
