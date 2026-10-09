import { describe, expect, it } from "vitest";
import { AiError } from "@/lib/ai/errors";
import type { ScanPages } from "@/lib/ai/schemas";
import type { ScanPageReading } from "@/lib/types";
import { keyPageCountHint, normalizeScanReadings, parsePageMarker, proposeLayout } from "./split";

type OutputPage = ScanPages["pages"][number];

function outputPage(chunkPage: number, o: Partial<OutputPage> = {}): OutputPage {
  return {
    chunk_page: chunkPage, kind: "student_work", starts_new_paper: false, student_name: null, section_raw: null, page_marker: null,
    worksheet_page: null, confidence: "high", note: "", ...o,
  };
}

function reading(o: Partial<ScanPageReading> = {}): ScanPageReading {
  return {
    kind: "student_work", startsNewPaper: false, studentName: null, sectionRaw: null, pageMarker: null, worksheetPage: null,
    confidence: "medium", note: "", reported: true, ...o,
  };
}

/** The 1-based pages that start a paper. */
function starts(layout: ReturnType<typeof proposeLayout>): number[] {
  return layout.flatMap((p, i) => (p.startsPaper ? [i + 1] : []));
}

describe("normalizeScanReadings", () => {
  it("maps each page in chunk order and cleans its fields", () => {
    const readings = normalizeScanReadings({
      pages: [
        outputPage(2, { student_name: "  ", page_marker: "", note: "  upside down " }),
        outputPage(1, {
          starts_new_paper: true, student_name: ` ${"N".repeat(130)} `, section_raw: "P".repeat(70), page_marker: "1 of 2",
          worksheet_page: 1.4, confidence: "medium",
        }),
      ],
    }, { chunkPageCount: 2 });
    expect(readings).toEqual([
      {
        kind: "student_work", startsNewPaper: true, studentName: "N".repeat(120), sectionRaw: "P".repeat(60), pageMarker: "1 of 2",
        worksheetPage: 1, confidence: "medium", note: "", reported: true,
      },
      {
        kind: "student_work", startsNewPaper: false, studentName: null, sectionRaw: null, pageMarker: null, worksheetPage: null,
        confidence: "high", note: "upside down", reported: true,
      },
    ]);
  });

  it("keeps the first of duplicate pages, rounds page numbers and ignores pages outside the chunk", () => {
    const readings = normalizeScanReadings({
      pages: [
        outputPage(1, { student_name: "First" }), outputPage(1, { student_name: "Second" }), outputPage(2.2, { student_name: "Two" }),
        outputPage(0, { student_name: "Zero" }), outputPage(4, { student_name: "Four" }), outputPage(-1),
      ],
    }, { chunkPageCount: 3 });
    expect(readings.map((r) => r.studentName)).toEqual(["First", "Two", null]);
  });

  it("puts a low-confidence placeholder where the AI skipped a page", () => {
    const readings = normalizeScanReadings({ pages: [outputPage(1), outputPage(3)] }, { chunkPageCount: 4 });
    expect(readings[1]).toEqual({
      kind: "student_work", startsNewPaper: false, studentName: null, sectionRaw: null, pageMarker: null, worksheetPage: null,
      confidence: "low", note: "", reported: false,
    });
    expect(readings.map((r) => r.reported)).toEqual([true, false, true, false]);
  });

  it("drops worksheet pages below 1", () => {
    const readings = normalizeScanReadings({
      pages: [outputPage(1, { worksheet_page: 0 }), outputPage(2, { worksheet_page: -3 }), outputPage(3, { worksheet_page: 2.6 })],
    }, { chunkPageCount: 3 });
    expect(readings.map((r) => r.worksheetPage)).toEqual([null, null, 3]);
  });

  it("rejects an answer that describes fewer than half of the pages, retryably", () => {
    expect(normalizeScanReadings({ pages: [outputPage(1), outputPage(2)] }, { chunkPageCount: 4 })).toHaveLength(4);
    let error: unknown;
    try {
      normalizeScanReadings({ pages: [outputPage(1), outputPage(1), outputPage(9)] }, { chunkPageCount: 5 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ code: "invalid_output", message: "The AI described too few of the scanned pages.", o: { retryable: true } });
  });
});

describe("parsePageMarker", () => {
  it.each([
    ["2 of 3", { page: 2, of: 3 }],
    ["Page 1/4", { page: 1, of: 4 }],
    ["p. 3 OF 5", { page: 3, of: 5 }],
    ["2", { page: 2, of: null }],
    ["p. 7", { page: 7, of: null }],
  ])("reads %s", (marker, expected) => {
    expect(parsePageMarker(marker)).toEqual(expected);
  });

  it.each([null, "", "back", "p. 2 - 3"])("returns null for %s", (marker) => {
    expect(parsePageMarker(marker)).toBeNull();
  });
});

describe("proposeLayout", () => {
  it("leaves out blank, cover and answer-key pages and never starts a paper on them", () => {
    const layout = proposeLayout([
      reading({ kind: "cover_or_separator", startsNewPaper: true }),
      reading({ startsNewPaper: true, confidence: "high" }),
      reading({ kind: "blank" }),
      reading({ kind: "answer_key", startsNewPaper: true }),
      reading({ confidence: "high" }),
      reading({ kind: "other", confidence: "high" }),
    ], { keyPageCount: null });
    expect(layout).toEqual([
      { startsPaper: false, dropped: true },
      { startsPaper: true, dropped: false },
      { startsPaper: false, dropped: true },
      { startsPaper: false, dropped: true },
      { startsPaper: false, dropped: false },
      { startsPaper: false, dropped: false },
    ]);
  });

  it("starts at the first kept page and wherever the model says a paper starts", () => {
    const layout = proposeLayout([
      reading({ confidence: "low" }), reading({ confidence: "high" }), reading({ startsNewPaper: true, confidence: "low" }),
    ], { keyPageCount: null });
    expect(starts(layout)).toEqual([1, 3]);
  });

  it("follows a high-confidence continuation even when the name or marker says otherwise", () => {
    const layout = proposeLayout([
      reading({ studentName: "Ana Ruiz", startsNewPaper: true }),
      reading({ studentName: "Ben Cho", pageMarker: "1 of 2", worksheetPage: 1, confidence: "high" }),
    ], { keyPageCount: 1 });
    expect(starts(layout)).toEqual([1]);
  });

  it("starts an unsure page with a different name, but not the same name written differently", () => {
    const layout = proposeLayout([
      reading({ studentName: "Ana Ruiz", startsNewPaper: true }),
      reading({ studentName: "RUIZ, ANA" }),
      reading({ studentName: "Ben Cho" }),
      reading({}),
    ], { keyPageCount: null });
    expect(starts(layout)).toEqual([1, 3]);
  });

  it("keeps a first name alone, an initial, or a near reading of the same name on an unsure page", () => {
    // A name line on every page: page 2 reads "Maria", worksheet page 2, and the model says it continues (medium).
    const twoPapers = proposeLayout([
      reading({ studentName: "Maria Garcia", startsNewPaper: true, confidence: "high", worksheetPage: 1 }),
      reading({ studentName: "Maria", worksheetPage: 2 }),
      reading({ studentName: "Ben Cho", startsNewPaper: true, confidence: "high", worksheetPage: 1, pageMarker: "1 of 2" }),
      reading({ studentName: "Ben", worksheetPage: 2, pageMarker: "2 of 2" }),
    ], { keyPageCount: 2 });
    expect(starts(twoPapers)).toEqual([1, 3]);
    expect(starts(proposeLayout([
      reading({ studentName: "Jayden Smith", startsNewPaper: true, confidence: "high" }),
      reading({ studentName: "Jaydon Smith", worksheetPage: 2, confidence: "low" }),
      reading({ studentName: "J. Smith" }),
    ], { keyPageCount: null }))).toEqual([1]);
  });

  it("starts a paper on a clearly different name even with a later-page marker, unless the names share a word", () => {
    // "2 of 2" does not say whose page it is.
    expect(starts(proposeLayout([
      reading({ studentName: "Ana Ruiz", startsNewPaper: true }), reading({ studentName: "Ben Cho", pageMarker: "2 of 2" }),
    ], { keyPageCount: null }))).toEqual([1, 2]);
    // The same first name with another surname on a page that continues the worksheet is a misread surname...
    expect(starts(proposeLayout([
      reading({ studentName: "Maria Garcia", startsNewPaper: true }), reading({ studentName: "Maria Gomez", worksheetPage: 2 }),
    ], { keyPageCount: null }))).toEqual([1]);
    // ...but without that evidence it is another student.
    expect(starts(proposeLayout([
      reading({ studentName: "Maria Garcia", startsNewPaper: true }), reading({ studentName: "Maria Gomez" }),
    ], { keyPageCount: null }))).toEqual([1, 2]);
  });

  it("continues the paper on an unsure start that shows its name on a later worksheet page", () => {
    // The first page of a chunk, read alone: page 3 of Gus's paper with "Name: Gus" on it, reported as a start.
    const readings = [
      reading({ studentName: "Gus Park", startsNewPaper: true, confidence: "high", worksheetPage: 1 }),
      reading({ studentName: "Gus Park", worksheetPage: 2, confidence: "high" }),
      reading({ studentName: "Gus Park", startsNewPaper: true, confidence: "low", worksheetPage: 3 }),
      reading({ studentName: "Hana Lee", startsNewPaper: true, confidence: "high", worksheetPage: 1 }),
    ];
    expect(starts(proposeLayout(readings, { keyPageCount: 3 }))).toEqual([1, 4]);
    // A start the model is sure of, one without a later-page sign, or one with another name is still followed.
    expect(starts(proposeLayout([readings[0], readings[1], { ...readings[2], confidence: "high" }], { keyPageCount: 3 }))).toEqual([1, 3]);
    expect(starts(proposeLayout([readings[0], readings[1], { ...readings[2], worksheetPage: null }], { keyPageCount: 3 }))).toEqual([1, 3]);
    expect(starts(proposeLayout([readings[0], readings[1], { ...readings[2], worksheetPage: 1 }], { keyPageCount: 3 }))).toEqual([1, 3]);
    expect(starts(proposeLayout([readings[0], readings[1], { ...readings[2], studentName: "Hana Lee" }], { keyPageCount: 3 })))
      .toEqual([1, 3]);
    expect(starts(proposeLayout([readings[0], readings[1], { ...readings[2], studentName: null, pageMarker: "3 of 3" }],
      { keyPageCount: 3 }))).toEqual([1, 3]);
    // A "3 of 3" marker counts as the later-page sign too.
    expect(starts(proposeLayout([readings[0], readings[1], { ...readings[2], worksheetPage: null, pageMarker: "3 of 3" }],
      { keyPageCount: 3 }))).toEqual([1]);
  });

  it("takes the paper's name from its first named page", () => {
    const layout = proposeLayout([
      reading({ startsNewPaper: true }), reading({ studentName: "Ana Ruiz" }), reading({ studentName: "Ben Cho" }),
    ], { keyPageCount: null });
    expect(starts(layout)).toEqual([1, 3]);
  });

  it("starts an unsure page marked as page 1", () => {
    const layout = proposeLayout([reading({ startsNewPaper: true }), reading({ pageMarker: "2 of 2" }), reading({ pageMarker: "1 of 2" })],
      { keyPageCount: null });
    expect(starts(layout)).toEqual([1, 3]);
  });

  it("starts an unsure page where the worksheet restarts, unless its marker says otherwise", () => {
    const restart = proposeLayout([reading({ startsNewPaper: true, worksheetPage: 1 }), reading({ worksheetPage: 2 }), reading({ worksheetPage: 1 })],
      { keyPageCount: null });
    expect(starts(restart)).toEqual([1, 3]);
    const marked = proposeLayout([reading({ startsNewPaper: true, worksheetPage: 1 }), reading({ worksheetPage: 1, pageMarker: "page 2" })],
      { keyPageCount: null });
    expect(starts(marked)).toEqual([1]);
    const unknownBefore = proposeLayout([reading({ startsNewPaper: true }), reading({ worksheetPage: 1 })], { keyPageCount: null });
    expect(starts(unknownBefore)).toEqual([1]);
  });

  describe("with the key's page count as a hint", () => {
    const paperOf3 = [reading({ startsNewPaper: true, studentName: "Ana Ruiz" }), reading({}), reading({})];

    it("starts an unsure, unmarked page after a paper of the worksheet's length", () => {
      expect(starts(proposeLayout([...paperOf3, reading({}), reading({})], { keyPageCount: 3 }))).toEqual([1, 4]);
    });

    it("keeps a page that says it continues the paper", () => {
      expect(starts(proposeLayout([...paperOf3, reading({ pageMarker: "4 of 4" })], { keyPageCount: 3 }))).toEqual([1]);
      expect(starts(proposeLayout([...paperOf3, reading({ worksheetPage: 2 })], { keyPageCount: 3 }))).toEqual([1]);
      expect(starts(proposeLayout([...paperOf3, reading({ studentName: "ana ruiz" })], { keyPageCount: 3 }))).toEqual([1]);
    });

    it("never overrides a confident reading", () => {
      expect(starts(proposeLayout([...paperOf3, reading({ confidence: "high" })], { keyPageCount: 3 }))).toEqual([1]);
    });

    it("does not count left-out pages towards the length", () => {
      const layout = proposeLayout([paperOf3[0], reading({}), reading({ kind: "blank" }), reading({})], { keyPageCount: 3 });
      expect(starts(layout)).toEqual([1]);
    });

    it("never fires without a key page count", () => {
      expect(starts(proposeLayout([...paperOf3, reading({}), reading({})], { keyPageCount: null }))).toEqual([1]);
    });
  });
});

describe("keyPageCountHint", () => {
  it("uses a blank worksheet's page count", () => {
    expect(keyPageCountHint({ sourcePageCount: 2, documentKind: "blank_worksheet" }, [])).toBe(2);
    expect(keyPageCountHint({ sourcePageCount: 3, documentKind: "blank_worksheet" }, [{ page: 1 }, { page: 2 }])).toBe(3);
  });

  it("uses the highest item page when the items are spread over several pages of the key", () => {
    // A filled-in three-page worksheet.
    expect(keyPageCountHint({ sourcePageCount: 3, documentKind: "answer_key" }, [{ page: 1 }, { page: 2 }, { page: 3 }])).toBe(3);
    expect(keyPageCountHint({ sourcePageCount: 4, documentKind: "answer_key" }, [{ page: 2 }, { page: 1 }, { page: null }])).toBe(2);
    expect(keyPageCountHint({ sourcePageCount: 5, documentKind: "student_work" }, [{ page: 1 }, { page: 2 }, { page: null }])).toBe(2);
    expect(keyPageCountHint({ sourcePageCount: null, documentKind: null }, [{ page: 2 }, { page: 1 }])).toBe(2);
  });

  it("is null for an answer key with every item on one page, which may be a list of answers for a longer worksheet", () => {
    // A one-page answer list for a three-page worksheet must not say papers have one page.
    expect(keyPageCountHint({ sourcePageCount: 1, documentKind: "answer_key" }, [{ page: 1 }, { page: 1 }, { page: 1 }])).toBeNull();
    expect(keyPageCountHint({ sourcePageCount: 3, documentKind: "answer_key" }, [{ page: 1 }])).toBeNull();
    expect(keyPageCountHint({ sourcePageCount: 5, documentKind: "unrelated" }, [{ page: 4 }])).toBeNull();
  });

  it("is null when nothing tells", () => {
    expect(keyPageCountHint({ sourcePageCount: null, documentKind: null }, [{ page: null }])).toBeNull();
    expect(keyPageCountHint({ sourcePageCount: 0, documentKind: "answer_key" }, [])).toBeNull();
    expect(keyPageCountHint({ sourcePageCount: 0, documentKind: "blank_worksheet" }, [])).toBeNull();
  });
});
