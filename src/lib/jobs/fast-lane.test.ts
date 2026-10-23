import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PacketReadInput, ReadInput, TranscribeInput } from "@/lib/ai/grader";
import { getScan, updateSplittingScan } from "@/lib/db/repos/scans";
import { getSplitProgress } from "@/lib/services/progress";
import { getScanReviewView } from "@/lib/services/views";
import { listItems, listSubmissions } from "@/lib/db/repos/submissions";
import { drainQueue, FAKE_META, scriptedGrader } from "@/lib/jobs/test-utils";
import { CLASS_PACKET, type ClassScanStudent, type FixtureMark, makeClassScan, makeWorksheet, PLANTS_QUIZ } from "@/lib/omr/fixtures";
import { saveRoster } from "@/lib/services/rosters";
import { ingestScan } from "@/lib/services/scans";
import { ingestBlankWorksheet, saveSpots } from "@/lib/services/worksheets";
import type { Assignment, KeyItem } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedScan, seedTeacher, useTestDb } from "@/test/helpers";

// The fast lane end to end: a blank worksheet (pdf-lib, three pages) with its spots saved, a whole class "scanned" from it
// into one PDF, graded by the worker with a scripted engine that records every AI call. The AI must only ever see crops.

let assignment: Assignment;
let items: KeyItem[];
let packet: Awaited<ReturnType<typeof makeWorksheet>>;

beforeAll(async () => {
  packet = await makeWorksheet(CLASS_PACKET, { title: "Plants Packet" });
});

beforeEach(async () => {
  useTestDb();
  assignment = seedAssignment(seedTeacher().id, { gradingMode: "accuracy" });
  items = seedApprovedKey(assignment.id, [
    { label: "1", answerType: "multiple_choice", prompt: "Which process?", expectedAnswer: "B) photosynthesis", acceptableAnswers: ["B"] },
    { label: "2", answerType: "numeric", prompt: "Solve 3/x = 9/12.", expectedAnswer: "x = 4", acceptableAnswers: ["4"] },
    { label: "3", answerType: "true_false", prompt: "The sun is a star.", expectedAnswer: "True" },
    { label: "4", answerType: "long_answer", prompt: "Why are leaves green?", expectedAnswer: "Chlorophyll reflects green light." },
    { label: "5", answerType: "short_answer", prompt: "Gas plants give off?", expectedAnswer: "oxygen" },
    { label: "6", answerType: "multiple_choice", prompt: "Do plants need light?", expectedAnswer: "Yes" },
    { label: "7", answerType: "multiple_choice", prompt: "Which part takes in water?", expectedAnswer: "B) root", acceptableAnswers: ["B"] },
    { label: "8", answerType: "long_answer", prompt: "What happens to a seed?", expectedAnswer: "It germinates." },
    { label: "9", answerType: "short_answer", prompt: "Water boils at", expectedAnswer: "100 C" },
    { label: "10", answerType: "multiple_choice", prompt: "The leaves (is/are) green.", expectedAnswer: "are" },
    { label: "11", answerType: "long_answer", prompt: "The water cycle?", expectedAnswer: "Evaporation, condensation, precipitation." },
  ]);
  const ws = await ingestBlankWorksheet(assignment, [{ filename: "packet.pdf", bytes: packet.pdf }]);
  saveSpots(assignment, ws.spots);
});

const NAMES = ["Maria Lopez", "James Brown", "Wei Chen", "Aisha Khan", "Liam Murphy", "Sofia Rossi", "Noah Smith", "Emma Jones", "Omar Haddad"];
/** How the scripted reader "misreads" each name (the class list puts them right). */
const MISREAD: Record<string, string> = { "Maria Lopez": "Mria Lopes", "James Brown": "Brown, James", "Wei Chen": "Wei Chen" };

function marksFor(i: number): FixtureMark[] {
  return [
    { q: "1", circle: i === 1 ? "C" : "B" }, { q: "2", write: "4" }, { q: "3", circle: "True" }, { q: "4", write: "Chlorophyll" },
    { q: "5", write: "oxygen" }, { q: "6", tick: "Yes" }, { q: "7", circle: "B" }, { q: "8", write: "It sprouts" },
    { q: "9", write: "100 C" }, { q: "10", circle: "are" }, { q: "11", write: "It rains" },
  ];
}

function student(i: number, o: Partial<ClassScanStudent> = {}): ClassScanStudent {
  const warps = [{ dx: 6, dy: -5, rotate: 0.9 }, { dx: -9, dy: 7, rotate: -1.4, scale: 1.01 }, { dx: 3, dy: 9, rotate: 1.8, scale: 0.99 }];
  return { name: NAMES[i], marks: marksFor(i), warp: warps[i % warps.length], ...o };
}

const TEXT: Record<string, string> = { Q2: "x = 4", Q5: "oxygen", Q9: "100 C" };

/** A grader that records every AI call; reading whole pages is an error unless `allowPages`. */
function recorder(o: { allowPages?: boolean } = {}) {
  const transcribe: TranscribeInput[] = [];
  const reads: ReadInput[] = [];
  const chunks: PacketReadInput[] = [];
  let names: string[] = [];
  const grader = scriptedGrader({
    async transcribeCrops(input) {
      transcribe.push(input);
      return {
        output: {
          crops: input.crops.map((c) => {
            const [paper, ref] = c.id.split("-");
            const n = Number(paper.slice(1)) - 1;
            const text = ref === "NAME" ? (MISREAD[names[n]] ?? names[n]) : (TEXT[ref] ?? `Sample answer for ${ref}`);
            return { id: c.id, text, confidence: "high" as const };
          }),
        },
        meta: FAKE_META,
      };
    },
    async readSubmission(input, opts) {
      reads.push(input);
      if (!o.allowPages) throw new Error("the fast lane must not send a whole page");
      return (await import("@/lib/ai/fake")).createFakeGrader({ delayMs: 0 }).readSubmission(input, opts);
    },
    async readPacketChunk(input, opts) {
      chunks.push(input);
      if (!o.allowPages) throw new Error("the fast lane must not send a whole page");
      return (await import("@/lib/ai/fake")).createFakeGrader({ delayMs: 0 }).readPacketChunk!(input, opts);
    },
  });
  return { grader, transcribe, reads, chunks, setNames: (n: string[]) => { names = n; } };
}

async function gradeScan(bytes: Uint8Array, rec: ReturnType<typeof recorder>) {
  const scan = await ingestScan(assignment, [{ filename: "class.pdf", bytes }], { mode: "one_pass", pagesPerPaper: null });
  await drainQueue(rec.grader);
  return getScan(scan.id)!;
}

function judgmentsOf(submissionId: string) {
  const byLabel = new Map(items.map((item) => [item.id, item.label]));
  return Object.fromEntries(listItems(submissionId).map((row) => [byLabel.get(row.itemId)!, row.judgment!]));
}

describe("the fast lane: a class scan graded from the blank worksheet", () => {
  it("splits 26 pages into 9 papers by matching them to the blank, reads names and answers from crops only, and grades them", async () => {
    saveRoster(assignment, NAMES.join("\n"));
    // Nine students; the fifth lost their last page: 9 × 3 − 1 = 26 pages.
    const students = NAMES.map((_, i) => student(i, i === 4 ? { drop: [3] } : {}));
    const bytes = await makeClassScan(packet, students);
    const rec = recorder();
    rec.setNames(NAMES);
    const started = performance.now();
    const scan = await gradeScan(bytes, rec);
    const elapsed = performance.now() - started;

    expect(scan.pageCount).toBe(26);
    expect(scan.status).toBe("done");
    expect(scan.onePass?.fastLane).toMatchObject({ stage: "done", done: 9, total: 9 });
    expect(scan.onePass?.papers.map((p) => p.pages)).toEqual([
      [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14], [15, 16, 17], [18, 19, 20], [21, 22, 23], [24, 25, 26],
    ]);
    expect(scan.onePass?.skipped).toEqual([]);

    // Not one whole page went to the AI: only crops, names in batches of their own (with the class list), answers after.
    expect(rec.reads).toHaveLength(0);
    expect(rec.chunks).toHaveLength(0);
    for (const call of rec.transcribe) {
      for (const crop of call.crops) expect(Object.keys(crop).sort()).toEqual(["height", "id", "kind", "png", "width"]);
      expect(call.crops.length).toBeLessThanOrEqual(8);
    }
    const identityCalls = rec.transcribe.filter((c) => c.crops.every((x) => x.kind === "name" || x.kind === "section"));
    const answerCalls = rec.transcribe.filter((c) => c.crops.every((x) => x.kind !== "name" && x.kind !== "section"));
    expect(identityCalls.length + answerCalls.length).toBe(rec.transcribe.length);
    for (const call of identityCalls) expect(call.nameHints).toEqual(NAMES);
    for (const call of answerCalls) expect(call.nameHints).toBeUndefined();
    const nameCrops = identityCalls.flatMap((c) => c.crops).length;
    const answerCrops = answerCalls.flatMap((c) => c.crops).length;
    expect(nameCrops).toBe(9);
    expect(answerCrops).toBe(8 * 6 + 5); // six written answers a paper; the fifth paper has no page 3 (Q11)
    expect(rec.transcribe.length).toBe(Math.ceil(nameCrops / 8) + Math.ceil(answerCrops / 8));

    const subs = listSubmissions(assignment.id).sort((a, b) => a.originalFilename.localeCompare(b.originalFilename, "en", { numeric: true }));
    expect(subs).toHaveLength(9);
    expect(subs.every((s) => s.fastLane)).toBe(true);
    // The class list's spelling, with the reading kept.
    const byName = new Map(subs.map((s) => [s.studentName, s]));
    expect([...byName.keys()].sort()).toEqual([...NAMES].sort());
    expect(byName.get("Maria Lopez")).toMatchObject({ aiName: "Mria Lopes", rosterName: "Maria Lopez" });
    expect(byName.get("James Brown")).toMatchObject({ aiName: "Brown, James", rosterName: "James Brown" });
    for (const s of subs) expect(s.flags).not.toContain("name_uncertain");

    // Marks: every choice from the ink, written answers from their crops, marked in code; the long answers judged.
    const maria = judgmentsOf(byName.get("Maria Lopez")!.id);
    expect(maria["1"]).toMatchObject({ studentAnswer: "B", correctness: "correct", judgedBy: "program" });
    expect(maria["2"]).toMatchObject({ studentAnswer: "x = 4", correctness: "correct", judgedBy: "program" });
    expect(maria["3"]).toMatchObject({ studentAnswer: "True", correctness: "correct", judgedBy: "program" });
    expect(maria["6"]).toMatchObject({ studentAnswer: "Yes", correctness: "correct", judgedBy: "program" });
    expect(maria["10"]).toMatchObject({ studentAnswer: "are", correctness: "correct", judgedBy: "program" });
    expect(maria["4"]).toMatchObject({ studentAnswer: "Sample answer for Q4", judgedBy: "ai" });
    expect(maria["11"].spot?.page).toBe(3);
    const james = judgmentsOf(byName.get("James Brown")!.id);
    expect(james["1"]).toMatchObject({ studentAnswer: "C", correctness: "incorrect", judgedBy: "program" });
    expect(byName.get("Maria Lopez")).toMatchObject({ status: "graded", scoreMaxCenti: 1100, scoreEarnedCenti: 1100 });
    expect(byName.get("James Brown")!.scoreEarnedCenti).toBe(1000);
    for (const s of subs) expect(s.readMs).not.toBeNull();

    // The paper that lost a page: kept with its two pages, flagged, its page-3 item unanswered for the teacher to check.
    const liam = byName.get("Liam Murphy")!;
    expect(liam.pageCount).toBe(2);
    expect(liam.flags).toEqual(expect.arrayContaining(["paper_boundary", "pages_missing"]));
    expect(liam.teacherSummary).toMatch(/Worksheet page 3 of this paper wasn't found/);
    expect(judgmentsOf(liam.id)["11"]).toMatchObject({ correctness: "no_answer" });
    for (const s of subs.filter((x) => x !== liam)) expect(s.flags).not.toContain("paper_boundary");

    console.info(`[fast-lane test] 26 pages, 9 papers, ${rec.transcribe.length} AI calls, ${Math.round(elapsed)} ms`);
  }, 180_000);

  it("two consecutive students on a two-page worksheet are two papers, also without a name on the second", async () => {
    const two = await makeWorksheet(PLANTS_QUIZ.concat([
      { label: "6", text: "Describe the roots of a tree.", room: 4.5 },
      { label: "7", text: "Which part of the plant makes seeds?", options: { kind: "letters", items: ["leaf", "root", "flower", "stem"] } },
      { label: "8", text: "Name one plant that grows in a desert.", blank: true },
    ]), { title: "Two pages" });
    expect([6, 7, 8].map((q) => two.layout.questions[String(q)].page)).toEqual([2, 2, 2]);
    seedApprovedKey(assignment.id, [
      { label: "1", answerType: "multiple_choice", prompt: "Which process?", expectedAnswer: "B" },
      { label: "2", answerType: "numeric", prompt: "x?", expectedAnswer: "4" },
      { label: "6", answerType: "long_answer", prompt: "Roots?", expectedAnswer: "They anchor." },
      { label: "7", answerType: "multiple_choice", prompt: "Seeds?", expectedAnswer: "C" },
      { label: "8", answerType: "short_answer", prompt: "Desert plant?", expectedAnswer: "cactus" },
    ]);
    const ws = await ingestBlankWorksheet(assignment, [{ filename: "two.pdf", bytes: two.pdf }]);
    saveSpots(assignment, ws.spots);
    const marks: FixtureMark[] = [{ q: "1", circle: "B" }, { q: "2", write: "4" }, { q: "6", write: "They hold the tree" }, { q: "7", circle: "C" }];
    const bytes = await makeClassScan(two, [
      { name: "Maria Lopez", marks, warp: { dx: 4, dy: -3, rotate: 0.7 } },
      { marks, warp: { dx: -5, dy: 6, rotate: -1.1 } },
      { name: "Wei Chen", marks, warp: { dx: 2, dy: 2, rotate: 0.3 }, drop: [2] },
      { name: "Aisha Khan", marks, warp: { dx: -2, dy: 5, rotate: -0.5 } },
    ]);
    const rec = recorder();
    rec.setNames(["Maria Lopez", "", "Wei Chen", "Aisha Khan"]);
    const scan = await gradeScan(bytes, rec);
    expect(scan.status).toBe("done");
    expect(scan.onePass?.papers.map((p) => [p.pages, p.flagged])).toEqual([
      [[1, 2], false], [[3, 4], true], [[5], true], [[6, 7], false],
    ]);
    const subs = listSubmissions(assignment.id);
    const unnamed = subs.find((s) => s.studentName === null)!;
    expect(unnamed.flags).toEqual(expect.arrayContaining(["name_missing", "paper_boundary"]));
    expect(unnamed.teacherSummary).toMatch(/Nothing is written where the name goes/);
    const wei = subs.find((s) => s.studentName === "Wei Chen")!;
    expect(wei.flags).toEqual(expect.arrayContaining(["paper_boundary", "pages_missing"]));
    expect(rec.reads).toHaveLength(0);
  }, 120_000);

  it("skips a cover page and blank backs, and reports them", async () => {
    const bytes = await makeClassScan(packet, [student(0, { blankAfter: true }), student(1)], { cover: true });
    const rec = recorder();
    rec.setNames(NAMES);
    const scan = await gradeScan(bytes, rec);
    expect(scan.status).toBe("done");
    expect(scan.onePass?.papers.map((p) => p.pages)).toEqual([[2, 3, 4], [6, 7, 8]]);
    expect(scan.onePass?.skipped).toEqual([{ page: 1, reason: "other" }, { page: 5, reason: "blank" }]);
    expect(scan.onePass?.papers.every((p) => !p.flagged)).toBe(true);
  }, 120_000);

  it("reordered pages are put back in worksheet order and the paper is flagged", async () => {
    saveRoster(assignment, NAMES.join("\n"));
    const bytes = await makeClassScan(packet, [student(0, { order: [1, 3, 2] }), student(1)]);
    const rec = recorder();
    rec.setNames(NAMES);
    const scan = await gradeScan(bytes, rec);
    expect(scan.onePass?.papers.map((p) => [p.pages, p.flagged])).toEqual([[[1, 3, 2], true], [[4, 5, 6], false]]);
    const maria = listSubmissions(assignment.id).find((s) => s.studentName === "Maria Lopez")!;
    expect(judgmentsOf(maria.id)["8"]).toMatchObject({ studentAnswer: "Sample answer for Q8" });
    expect(maria.flags).toContain("paper_boundary");
  }, 120_000);

  it("falls back to the AI reading every page when the pages don't match the blank worksheet", async () => {
    const other = await makeWorksheet([{ label: "1", text: "Something else entirely", room: 5 }], { title: "Another sheet" });
    const bytes = await makeClassScan(other, [{ name: "A", marks: [] }, { name: "B", marks: [] }]);
    const rec = recorder({ allowPages: true });
    rec.setNames(NAMES);
    const scan = await gradeScan(bytes, rec);
    expect(scan.status).toBe("done");
    expect(rec.chunks.length).toBeGreaterThan(0);
    expect(scan.onePass?.fastLaneDeclined).toBe(true);
    expect(listSubmissions(assignment.id).every((s) => !s.fastLane)).toBe(true);
  }, 120_000);
});

describe("the fast lane's progress on the scan page", () => {
  it("shows the stage and how far it is, then that the fast lane graded the scan", async () => {
    const scan = await seedScan(assignment.id, { pages: 26, splitMode: "one_pass" });
    const progress = (stage: "matching" | "reading" | "marking" | "done", done: number, total: number) => {
      updateSplittingScan(scan.id, scan.splitGeneration, {
        onePass: {
          nextPage: 1, endedCleanly: true, chunks: 0, maxChunkPages: null, papers: [], skipped: [], pending: null,
          fastLane: { stage, done, total, startedAt: Date.now() },
        },
      });
      return getSplitProgress(getScan(scan.id)!);
    };
    expect(progress("matching", 12, 26)?.stage).toEqual({ kind: "matching", done: 12, total: 26 });
    expect(progress("reading", 40, 62)?.stage).toEqual({ kind: "reading", done: 40, total: 62 });
    expect(progress("marking", 3, 9)?.stage).toEqual({ kind: "marking", done: 3, total: 9 });
    expect(progress("done", 9, 9)?.stage).toBeUndefined();
    expect(getScanReviewView(getScan(scan.id)!, assignment).onePass?.fastLane).toBe(true);
  });
});
