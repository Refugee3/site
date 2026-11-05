import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGrader } from "@/lib/ai/fake";
import type { ReadInput, TranscribeInput } from "@/lib/ai/grader";
import { setGraderForTests } from "@/lib/ai/index";
import { getSubmission, listItems } from "@/lib/db/repos/submissions";
import { getWorksheet } from "@/lib/db/repos/worksheets";
import { drainQueue, scriptedGrader } from "@/lib/jobs/test-utils";
import { type FixtureMark, makeMarkedPaper, makeWorksheet, PLANTS_QUIZ, type ScanWarp } from "@/lib/omr/fixtures";
import { ingestTeacherUpload, regradeWithSpots, saveItemOverride, spotsStaleIds } from "@/lib/services/submissions";
import type { Assignment, KeyItem } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { activeSpotRevision, answerSpotsFor, findSpotsAgain, ingestBlankWorksheet, removeBlankWorksheet, saveSpots } from "./worksheets";

// The whole path: a blank worksheet made with pdf-lib, its spots found from the text layer and saved, then "scanned" papers
// graded by the worker with a practice grader that records what the AI was asked to read.

let assignment: Assignment;
let items: KeyItem[];
const worksheet = makeWorksheet(PLANTS_QUIZ);

beforeEach(() => {
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  items = seedApprovedKey(assignment.id, [
    { label: "1", answerType: "multiple_choice", prompt: "Which process?", expectedAnswer: "B) photosynthesis", acceptableAnswers: ["B"] },
    { label: "2", answerType: "numeric", prompt: "Solve 3/x = 9/12.", expectedAnswer: "x = 4", acceptableAnswers: ["4"] },
    { label: "3a", groupLabel: "3", answerType: "short_answer", prompt: "Gas taken in?", expectedAnswer: "carbon dioxide" },
    { label: "3b", groupLabel: "3", answerType: "short_answer", prompt: "Gas given off?", expectedAnswer: "oxygen" },
    { label: "4", answerType: "diagram", prompt: "Draw a plant cell.", expectedAnswer: "A labelled plant cell." },
    { label: "5", answerType: "long_answer", prompt: "Why are leaves green?", expectedAnswer: "Chlorophyll reflects green light." },
  ]);
});

async function uploadBlank() {
  const { pdf } = await worksheet;
  return ingestBlankWorksheet(assignment, [{ filename: "blank.pdf", bytes: pdf }]);
}

/** A grader that records what each AI call was sent. */
function recordingGrader(transcribe: Record<string, string> = {}) {
  const reads: ReadInput[] = [];
  const crops: TranscribeInput[] = [];
  const fake = createFakeGrader({ delayMs: 0, transcribeCrop: (id) => transcribe[id] });
  const grader = scriptedGrader({
    readSubmission: (input, o) => {
      reads.push(input);
      return fake.readSubmission(input, o);
    },
    transcribeCrops: (input, o) => {
      crops.push(input);
      return fake.transcribeCrops!(input, o);
    },
  });
  return { grader, reads, crops };
}

async function gradePaper(marks: FixtureMark[], o: { warp?: ScanWarp; transcribe?: Record<string, string>; label: string }) {
  const paper = await makeMarkedPaper(await worksheet, marks, { warp: o.warp ?? { dx: 6, dy: -5, rotate: 0.9 }, name: o.label });
  const { submissionId } = await ingestTeacherUpload(assignment, [{ filename: `${o.label}.pdf`, bytes: paper }]);
  const recorder = recordingGrader(o.transcribe);
  await drainQueue(recorder.grader);
  const byLabel = new Map(items.map((item) => [item.id, item.label]));
  const judgments = Object.fromEntries(listItems(submissionId).map((row) => [byLabel.get(row.itemId)!, row.judgment!]));
  return { submission: getSubmission(submissionId)!, judgments, ...recorder };
}

describe("blank worksheet", () => {
  it("finds the spots of a digital blank from its text, linked to the key; unconfirmed until saved", async () => {
    const ws = await uploadBlank();
    expect(ws).toMatchObject({ status: "ready", spotsSource: "text", hasText: true, pageCount: 1, confirmedAt: null });
    expect(ws.spots.map((s) => [s.itemLabel, s.kind])).toEqual([
      ["1", "choice"], ["2", "write_in"], ["3a", "write_in"], ["3b", "write_in"], ["4", "diagram"], ["5", "write_in"],
    ]);
    expect(answerSpotsFor(assignment.id, items)).toBeNull();
    saveSpots(assignment, ws.spots);
    expect(answerSpotsFor(assignment.id, items)?.refs).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
  });

  it("a scanned blank without text is proposed by the AI in the background, then waits for the teacher", async () => {
    setGraderForTests(createFakeGrader({ delayMs: 0 }));
    const { pdf } = await worksheet;
    // The same page as an image only: no text layer.
    const { openPdf, grayToPng } = await import("@/lib/omr/pdf-raster");
    const doc = await openPdf(pdf);
    const png = await grayToPng(await doc.renderGray(1, { dpi: 100 }));
    await doc.close();
    const ws = await ingestBlankWorksheet(assignment, [{ filename: "scan.png", bytes: png }]);
    expect(ws).toMatchObject({ status: "detecting", hasText: false });
    await vi.waitFor(() => expect(getWorksheet(assignment.id)?.status).toBe("ready"), { timeout: 10_000 });
    const done = getWorksheet(assignment.id)!;
    expect(done.spotsSource).toBe("ai");
    expect(done.spots.map((s) => s.itemLabel)).toEqual(["1", "2", "3a", "3b", "4", "5"]);
    expect(done.confirmedAt).toBeNull();
  });

  it("without an AI engine, a scanned blank is left for the teacher to draw", async () => {
    setGraderForTests(null);
    const { openPdf, grayToPng } = await import("@/lib/omr/pdf-raster");
    const doc = await openPdf((await worksheet).pdf);
    const png = await grayToPng(await doc.renderGray(1, { dpi: 72 }));
    await doc.close();
    const ws = await ingestBlankWorksheet(assignment, [{ filename: "scan.png", bytes: png }]);
    expect(ws).toMatchObject({ status: "ready", spotsSource: "manual", spots: [] });
    expect(ws.note).toMatch(/draw them yourself/);
  });

  it("each save is a new spots revision; papers are read with the saved revision only", async () => {
    const ws = await uploadBlank();
    expect(ws.spotsRevision).toBe(0);
    expect(activeSpotRevision(assignment.id)).toBeNull();
    expect(saveSpots(assignment, ws.spots).spotsRevision).toBe(1);
    expect(activeSpotRevision(assignment.id)).toBe(1);
    expect(saveSpots(assignment, ws.spots).spotsRevision).toBe(2);
    expect(activeSpotRevision(assignment.id)).toBe(2);
    await findSpotsAgain(assignment, { ai: false }); // unconfirmed: read without spots until saved again
    expect(activeSpotRevision(assignment.id)).toBeNull();
    expect(saveSpots(assignment, getWorksheet(assignment.id)!.spots).spotsRevision).toBe(3);
  });

  it("a paper graded before the spots were saved is regraded with mark detection in one click, keeping overrides", async () => {
    const ws = await uploadBlank();
    const early = await gradePaper([{ q: "1", circle: "B" }, { q: "5", write: "Chlorophyll" }], { label: "early" });
    expect(early.submission.gradedSpotRevision).toBeNull();
    expect(early.judgments["1"].spot).toBeUndefined();
    saveItemOverride(early.submission, items.find((item) => item.label === "5")!.id, { pointsCenti: 50, feedback: "Say more." });
    expect(spotsStaleIds(assignment)).toEqual([]); // spots not saved yet

    saveSpots(assignment, ws.spots);
    expect(spotsStaleIds(assignment)).toEqual([early.submission.id]);
    expect(regradeWithSpots(assignment)).toBe(1);
    await drainQueue(recordingGrader({ Q6: "Chlorophyll" }).grader);

    const byLabel = new Map(items.map((item) => [item.id, item.label]));
    const rows = new Map(listItems(early.submission.id).map((row) => [byLabel.get(row.itemId)!, row]));
    expect(rows.get("1")!.judgment).toMatchObject({ studentAnswer: "B", correctness: "correct", judgedBy: "program" });
    expect(rows.get("5")).toMatchObject({ overrideCenti: 50, overrideFeedback: "Say more." });
    expect(getSubmission(early.submission.id)!.gradedSpotRevision).toBe(1);
    expect(spotsStaleIds(assignment)).toEqual([]);
  });

  it("finds the spots again from the text, and can be removed", async () => {
    const ws = await uploadBlank();
    saveSpots(assignment, ws.spots.slice(0, 2));
    expect(getWorksheet(assignment.id)!.spots).toHaveLength(2);
    const again = await findSpotsAgain(assignment, { ai: false });
    expect(again.spots).toHaveLength(6);
    expect(again.confirmedAt).toBeNull();
    await removeBlankWorksheet(assignment);
    expect(getWorksheet(assignment.id)).toBeNull();
  });
});

describe("grading with mark detection", () => {
  beforeEach(async () => {
    const ws = await uploadBlank();
    saveSpots(assignment, ws.spots);
  });

  it("an unanswered paper: every item blank, from the marks alone; the name is read from its crop, no page goes to the AI", async () => {
    const { judgments, reads, crops, submission } = await gradePaper([], { label: "blank" });
    expect(Object.values(judgments).map((j) => [j.correctness, j.judgedBy])).toEqual(Array(6).fill(["no_answer", "program"]));
    // The name spot found on the blank ("Name: ____") is cropped and transcribed; nothing else is sent to the AI.
    expect(reads).toHaveLength(0);
    expect(crops).toHaveLength(1);
    expect(crops[0].crops.map((c) => [c.id, c.kind])).toEqual([["NAME", "name"]]);
    expect(submission.aiName).toBe("Sample answer for NAME");
    expect(judgments["1"].spot).toMatchObject({ kind: "choice", page: 1, marked: [] });
    expect(judgments["1"].marksSeen).toBe("no marks; every option clean");
    expect(submission.flags).not.toContain("worksheet_unaligned");
    expect(submission.gradedSpotRevision).toBe(1);
  });

  it("a circle on B is B, and correct; written answers are cropped and transcribed without the question", async () => {
    const { judgments, crops } = await gradePaper(
      [{ q: "1", circle: "B" }, { q: "2", write: "4" }, { q: "3a", write: "CO2" }, { q: "4", draw: true }],
      { label: "correct", transcribe: { Q2: "x = 4", Q3: "carbon dioxide" } },
    );
    expect(judgments["1"]).toMatchObject({ studentAnswer: "B", correctness: "correct", judgedBy: "program", confidence: "high" });
    expect(judgments["1"].marksSeen).toMatch(/^B: strong mark/);
    expect(judgments["2"]).toMatchObject({ studentAnswer: "x = 4", correctness: "correct", judgedBy: "program" });
    expect(judgments["3a"]).toMatchObject({ studentAnswer: "carbon dioxide", correctness: "correct" });
    expect(judgments["3b"]).toMatchObject({ correctness: "no_answer", judgedBy: "program" });
    expect(judgments["4"]).toMatchObject({ confidence: "low", reviewReason: "ambiguous_reading" });
    expect(judgments["5"]).toMatchObject({ correctness: "no_answer" });
    // One call for the name, then one with the three written spots, each only a crop (and no class list with answers).
    expect(crops).toHaveLength(2);
    expect(crops[0].crops.map((c) => [c.id, c.kind])).toEqual([["NAME", "name"]]);
    expect(crops[1].crops.map((c) => [c.id, c.kind])).toEqual([["Q2", "write_in"], ["Q3", "write_in"], ["Q5", "diagram"]]);
    expect(Object.keys(crops[1])).toEqual(["crops"]);
    expect(Object.keys(crops[1].crops[0]).sort()).toEqual(["height", "id", "kind", "png", "width"]);
  });

  it("a paper uploaded on its own: the name crop is read with the class list as hints, the answers without; the list's spelling wins", async () => {
    const { saveRoster } = await import("./rosters");
    saveRoster(assignment, "Ada Lovelace | Period 2\nAlan Turing");
    const { crops, reads, submission } = await gradePaper([{ q: "2", write: "4" }], { label: "Ada Lovelace", transcribe: { NAME: "Ada Lovelase", Q2: "4" } });
    expect(reads).toHaveLength(0);
    expect(crops).toHaveLength(2);
    expect(crops[0]).toMatchObject({ nameHints: ["Ada Lovelace", "Alan Turing"] });
    expect(crops[0].crops.map((c) => c.kind)).toEqual(["name"]);
    expect(crops[1].nameHints).toBeUndefined();
    expect(submission).toMatchObject({ studentName: "Ada Lovelace", aiName: "Ada Lovelase", rosterName: "Ada Lovelace", fastLane: false });
    expect(submission.flags).not.toContain("name_uncertain");
  });

  it("a circle on B where the key says C is incorrect", async () => {
    const keyC = items.map((item) => (item.label === "1" ? { ...item, expectedAnswer: "C) digestion", acceptableAnswers: [] } : item));
    seedApprovedKey(assignment.id, keyC);
    items = (await import("@/lib/db/repos/keys")).listKeyItems(assignment.id);
    saveSpots(assignment, getWorksheet(assignment.id)!.spots);
    const { judgments } = await gradePaper([{ q: "1", circle: "B" }], { label: "wrong" });
    expect(judgments["1"]).toMatchObject({ studentAnswer: "B", correctness: "incorrect", judgedBy: "program", reviewReason: "none" });
  });

  it("two marks go to the teacher as multiple answers", async () => {
    const { judgments, submission } = await gradePaper([{ q: "1", circle: "B" }, { q: "1", circle: "C" }], { label: "two" });
    expect(judgments["1"]).toMatchObject({ studentAnswer: "B, C", correctness: "incorrect", reviewReason: "multiple_answers" });
    expect(submission.status).toBe("needs_review");
  });

  it("a paper that doesn't line up is read by the AI as before, and flagged", async () => {
    const other = await makeWorksheet([{ label: "1", text: "Something else entirely", room: 5 }], { title: "Another sheet" });
    const paper = await makeMarkedPaper(other, []);
    const { submissionId } = await ingestTeacherUpload(assignment, [{ filename: "other.pdf", bytes: paper }]);
    const recorder = recordingGrader();
    await drainQueue(recorder.grader);
    expect(recorder.reads[0].items).toHaveLength(6);
    const s = getSubmission(submissionId)!;
    expect(s.flags).toContain("worksheet_unaligned");
    expect(s.teacherSummary).toMatch(/Couldn't line up/);
    expect(listItems(submissionId).every((row) => row.judgment?.spot === undefined)).toBe(true);
  });
});
