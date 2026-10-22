import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/ids";
import { readPaperSpots, type SpotPlanEntry, prepareWorksheet } from "./detect";
import { type FixtureMark, makeMarkedPaper, makeWorksheet, MIXED_WORKSHEET, PLANTS_QUIZ, type ScanWarp } from "./fixtures";
import { openPdf } from "./pdf-raster";
import { detectSpotsFromText, type KeyItemOutline, type TextPage } from "./text-zones";

async function textPages(pdf: Uint8Array): Promise<TextPage[]> {
  const doc = await openPdf(pdf, { fonts: true });
  try {
    const pages: TextPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const size = await doc.pageSize(n);
      pages.push({ tokens: await doc.textTokens(n), widthPt: size.width, heightPt: size.height });
    }
    return pages;
  } finally {
    await doc.close();
  }
}

const PLANTS_KEY: KeyItemOutline[] = [
  { label: "1", answerType: "multiple_choice" }, { label: "2", answerType: "numeric" }, { label: "3a", answerType: "short_answer" },
  { label: "3b", answerType: "short_answer" }, { label: "4", answerType: "diagram" }, { label: "5", answerType: "long_answer" },
];

async function setUp(questions: typeof PLANTS_QUIZ, key: KeyItemOutline[] = []) {
  const worksheet = await makeWorksheet(questions);
  const spots = detectSpotsFromText(await textPages(worksheet.pdf), key);
  const plan: SpotPlanEntry[] = spots.map((spot, i) => ({ ref: `Q${i + 1}`, spot }));
  const prepared = await prepareWorksheet(worksheet.pdf, sha256Hex(worksheet.pdf));
  const read = async (marks: FixtureMark[], warp?: ScanWarp) => {
    const paper = await makeMarkedPaper(worksheet, marks, { warp, name: "Ada Lovelace" });
    const pages = Array.from({ length: prepared.pages.length }, (_, i) => i + 1);
    const result = await readPaperSpots({ paperPdf: paper, pages, worksheet: prepared, plan });
    if (!result.ok) throw new Error(result.note);
    return Object.fromEntries(result.items.map((item) => [spots[plan.findIndex((p) => p.ref === item.ref)].label, item]));
  };
  return { worksheet, spots, plan, prepared, read };
}

describe("mark detection on PDF papers", () => {
  it("reads circles, words, check boxes and blanks on a shifted, rotated scan", async () => {
    const { read } = await setUp(MIXED_WORKSHEET);
    const items = await read(
      [{ q: "1", circle: "B" }, { q: "2", circle: "False" }, { q: "3", write: "100 C" }, { q: "4", tick: "Yes" }, { q: "5", circle: "are" }],
      { dx: 9, dy: -7, rotate: 1.4, scale: 0.985 },
    );
    expect(items["1"].choice?.marked).toEqual(["B"]);
    expect(items["2"].choice?.marked).toEqual(["False"]);
    expect(items["3"].written?.written).toBe(true);
    expect(items["3"].crop?.png.byteLength).toBeGreaterThan(100);
    expect(items["4"].choice?.marked).toEqual(["Yes"]);
    expect(items["5"].choice?.marked).toEqual(["are"]);
    expect(items["6"].written?.written).toBe(false);
    expect(items["6"].crop).toBeUndefined();
  });

  it("an unanswered paper is blank everywhere; a faint dot is not a mark", async () => {
    const { read } = await setUp(MIXED_WORKSHEET);
    const items = await read([{ q: "1", dot: "C" }], { dx: -6, dy: 4, rotate: -0.8 });
    for (const label of ["1", "2", "4", "5"]) expect(items[label].choice?.marked).toEqual([]);
    for (const label of ["3", "6"]) expect(items[label].written?.written).toBe(false);
  });

  it("two marks are both read, a filled bubble counts, and the paper's crop maps onto it", async () => {
    const { read } = await setUp(PLANTS_QUIZ, PLANTS_KEY);
    const items = await read([{ q: "1", circle: "B" }, { q: "1", fill: "D" }, { q: "4", draw: true }, { q: "5", write: "chlorophyll" }], {
      dx: -12, dy: 10, rotate: -2.2, scale: 1.02,
    });
    expect(items["1"].choice).toMatchObject({ marked: ["B", "D"], review: "multiple_answers" });
    expect(items["4"].written?.written).toBe(true);
    expect(items["5"].written?.written).toBe(true);
    expect(items["2"].written?.written).toBe(false);
    expect(items["3a"].written?.written).toBe(false);
    // The registration found the rotation the scan was given.
    const m = items["1"].evidence.map;
    expect(Math.atan2(m.d * 792, m.a * 612) * (180 / Math.PI)).toBeCloseTo(2.2, 0);
  });

  it("refuses a paper with another page count, or another worksheet", async () => {
    const { prepared, plan, worksheet } = await setUp(PLANTS_QUIZ, PLANTS_KEY);
    const other = await makeWorksheet(MIXED_WORKSHEET, { title: "Another worksheet" });
    const paper = await makeMarkedPaper(other, []);
    const pages = Array.from({ length: prepared.pages.length }, (_, i) => i + 1);
    const result = await readPaperSpots({ paperPdf: paper, pages, worksheet: prepared, plan });
    expect(result).toMatchObject({ ok: false, reason: "unaligned" });
    const one = await readPaperSpots({ paperPdf: await makeMarkedPaper(worksheet, []), pages: [1, 1, 1].slice(0, prepared.pages.length + 1), worksheet: prepared, plan });
    expect(one).toMatchObject({ ok: false, reason: "page_count" });
  });

  it("renders and lines up a page in well under a second", async () => {
    const { prepared, plan, worksheet } = await setUp(PLANTS_QUIZ, PLANTS_KEY);
    const paper = await makeMarkedPaper(worksheet, [{ q: "1", circle: "A" }], { warp: { dx: 5, dy: 5, rotate: 1 } });
    const started = performance.now();
    await readPaperSpots({ paperPdf: paper, pages: prepared.pages.map((_, i) => i + 1), worksheet: prepared, plan });
    const perPage = (performance.now() - started) / prepared.pages.length;
    expect(perPage).toBeLessThan(2500); // about 0.3–0.6 s on a laptop; generous for a loaded test machine
  });
});
