import { beforeEach, describe, expect, it } from "vitest";
import type { OllamaChatRequest, OllamaClient } from "@/lib/ai/ollama/client";
import { createOllamaGrader } from "@/lib/ai/ollama/grader";
import { getScan } from "@/lib/db/repos/scans";
import { listSubmissions } from "@/lib/db/repos/submissions";
import { sha256Hex } from "@/lib/ids";
import { drainQueue } from "@/lib/jobs/test-utils";
import { prepareWorksheet } from "@/lib/omr/detect";
import { analyzeScan } from "@/lib/omr/fast-lane/scan";
import { CLASS_PACKET, type FixtureMark, makeClassScan, makeWorksheet } from "@/lib/omr/fixtures";
import { saveRoster } from "@/lib/services/rosters";
import { ingestScan } from "@/lib/services/scans";
import { fastLaneSpots, ingestBlankWorksheet, saveSpots } from "@/lib/services/worksheets";
import type { Assignment } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";

// Timings of the fast lane (run with FAST_LANE_BENCH=1; skipped otherwise): a synthetic 26-page class packet (9 students,
// a 3-page worksheet, one page lost), graded with the real Ollama grader over a mocked Ollama that sleeps for what a local
// vision model would take: a fixed overhead per call, prefill per megapixel of images and generation per output token
// (calibrated so that reading a whole page costs about what the AI one-pass path does on an RTX 3090 Ti with a 27–32B model,
// ~16 s a page). Sleeps are scaled by TIME_SCALE so the run is quick; the report scales them back.

const TIME_SCALE = Number(process.env.FAST_LANE_TIME_SCALE ?? 0.02);
const COST = { callMs: 500, prefillMsPerMpix: 1200, outputMsPerToken: 40 };
/** The one-pass AI path's cost per page at the same rates: a 990×1280 page image and ~320 output tokens (11 items, compact). */
const ONE_PASS_PAGE_MS = (990 * 1280 / 1e6) * COST.prefillMsPerMpix + 320 * COST.outputMsPerToken;

const NAMES = ["Maria Lopez", "James Brown", "Wei Chen", "Aisha Khan", "Liam Murphy", "Sofia Rossi", "Noah Smith", "Emma Jones", "Omar Haddad"];

function pngSize(b64: string): { width: number; height: number } {
  const bytes = Buffer.from(b64.slice(0, 64), "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A mocked Ollama: answers transcription calls (the only calls the fast lane makes here) after the emulated time. */
function mockOllama() {
  const stats = { calls: 0, images: 0, megapixels: 0, emulatedMs: 0 };
  const client: OllamaClient = {
    baseUrl: "http://mock",
    async version() {
      return "0.9.0";
    },
    async tags() {
      return [];
    },
    async capabilities() {
      return ["completion", "vision"];
    },
    async chat(req: OllamaChatRequest) {
      const user = req.messages.find((m) => m.role === "user")!;
      const images = user.images ?? [];
      const mpix = images.reduce((sum, b64) => {
        const { width, height } = pngSize(b64);
        return sum + (width * height) / 1e6;
      }, 0);
      const ids = /in this order: ([^\n]*)\./.exec(user.content)?.[1].split(", ") ?? [];
      const answer = JSON.stringify({
        crops: ids.map((id) => {
          const [paper, ref] = id.split("-");
          const n = Number(paper.slice(1)) - 1;
          return { id, text: ref === "NAME" ? NAMES[n] : ref === "Q2" ? "x = 4" : ref === "Q5" ? "oxygen" : ref === "Q9" ? "100 C" : "chlorophyll", confidence: "high" };
        }),
      });
      const ms = COST.callMs + mpix * COST.prefillMsPerMpix + (answer.length / 4) * COST.outputMsPerToken;
      stats.calls++;
      stats.images += images.length;
      stats.megapixels += mpix;
      stats.emulatedMs += ms;
      await new Promise((resolve) => setTimeout(resolve, ms * TIME_SCALE));
      return { model: req.model, message: { role: "assistant", content: answer }, done: true, done_reason: "stop", eval_count: Math.round(answer.length / 4) };
    },
  };
  return { client, stats };
}

let assignment: Assignment;

describe.runIf(process.env.FAST_LANE_BENCH === "1")("fast lane timings (FAST_LANE_BENCH=1)", () => {
  beforeEach(() => {
    useTestDb();
    assignment = seedAssignment(seedTeacher().id, { gradingMode: "accuracy" });
    seedApprovedKey(assignment.id, [
      { label: "1", answerType: "multiple_choice", prompt: "Which process?", expectedAnswer: "B" },
      { label: "2", answerType: "numeric", prompt: "Solve.", expectedAnswer: "x = 4", acceptableAnswers: ["4"] },
      { label: "3", answerType: "true_false", prompt: "The sun is a star.", expectedAnswer: "True" },
      { label: "4", answerType: "short_answer", prompt: "Pigment?", expectedAnswer: "chlorophyll" },
      { label: "5", answerType: "short_answer", prompt: "Gas?", expectedAnswer: "oxygen" },
      { label: "6", answerType: "multiple_choice", prompt: "Light?", expectedAnswer: "Yes" },
      { label: "7", answerType: "multiple_choice", prompt: "Water?", expectedAnswer: "B" },
      { label: "8", answerType: "short_answer", prompt: "Seed?", expectedAnswer: "chlorophyll" },
      { label: "9", answerType: "short_answer", prompt: "Boils at", expectedAnswer: "100 C" },
      { label: "10", answerType: "multiple_choice", prompt: "is/are", expectedAnswer: "are" },
      { label: "11", answerType: "short_answer", prompt: "Cycle?", expectedAnswer: "chlorophyll" },
    ]);
  });

  for (const concurrency of [1, 2]) {
    it(`26 pages, 9 students, Ollama ${concurrency} at a time`, async () => {
      const packet = await makeWorksheet(CLASS_PACKET, { title: "Plants Packet" });
      const ws = await ingestBlankWorksheet(assignment, [{ filename: "packet.pdf", bytes: packet.pdf }]);
      saveSpots(assignment, ws.spots);
      saveRoster(assignment, NAMES.join("\n"));
      const marks: FixtureMark[] = [
        { q: "1", circle: "B" }, { q: "2", write: "4" }, { q: "3", circle: "True" }, { q: "4", write: "Chlorophyll" }, { q: "5", write: "oxygen" },
        { q: "6", tick: "Yes" }, { q: "7", circle: "B" }, { q: "8", write: "It sprouts" }, { q: "9", write: "100 C" }, { q: "10", circle: "are" },
        { q: "11", write: "It rains" },
      ];
      const warps = [{ dx: 6, dy: -5, rotate: 0.9 }, { dx: -9, dy: 7, rotate: -1.4, scale: 1.01 }, { dx: 3, dy: 9, rotate: 1.8, scale: 0.99 }];
      const scanPdf = await makeClassScan(packet, NAMES.map((name, i) => ({ name, marks, warp: warps[i % 3], drop: i === 4 ? [3] : [] })));

      // Matching alone (no AI): the per-page cost of rendering, lining up and reading the spots.
      const spots = fastLaneSpots(assignment.id, (await import("@/lib/db/repos/keys")).listKeyItems(assignment.id))!;
      const worksheet = await prepareWorksheet(await spots.blankPdf(), sha256Hex(await spots.blankPdf()));
      const pages = await analyzeScan({ scanPdf, worksheet, plan: spots.plan, identity: await spots.identity() });
      const matchMs = pages.map((p) => p.matchMs);
      const readMs = pages.map((p) => p.readMs);

      const { client, stats } = mockOllama();
      const grader = createOllamaGrader({
        client,
        cfg: { model: "qwen2.5vl:32b", numCtx: 16384, imageMaxEdge: 1280, pagesPerCall: 4, timeoutMs: 600_000, maxPages: 200, concurrency, cropsPerCall: 8 },
      });
      const started = performance.now();
      const scan = await ingestScan(assignment, [{ filename: "class.pdf", bytes: scanPdf }], { mode: "one_pass", pagesPerPaper: null });
      await drainQueue(grader);
      const wallMs = performance.now() - started;
      expect(getScan(scan.id)!.status).toBe("done");
      expect(listSubmissions(assignment.id)).toHaveLength(9);

      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const cpuMs = wallMs - (stats.emulatedMs * TIME_SCALE) / concurrency;
      const emulatedWallMs = cpuMs + stats.emulatedMs / concurrency;
      console.info([
        `[fast-lane bench] concurrency ${concurrency}, ${pages.length} pages, ${pages.filter((p) => p.blankPage !== null).length} matched, `
          + `${pages.reduce((n, p) => n + p.tried, 0)} page fits (3-page blank)`,
        `  render + match: ${Math.round(sum(matchMs) / pages.length)} ms a page (max ${Math.max(...matchMs)}); `
          + `spot reading + crops: ${Math.round(sum(readMs) / pages.length)} ms a page`,
        `  AI: ${stats.calls} calls (${stats.images} crop images, ${stats.megapixels.toFixed(2)} MP), emulated model time `
          + `${(stats.emulatedMs / 1000).toFixed(1)} s`,
        `  run: ${(wallMs / 1000).toFixed(1)} s at TIME_SCALE ${TIME_SCALE}; at full model time ≈ ${(emulatedWallMs / 1000).toFixed(0)} s `
          + `(one-pass AI path at the same rates ≈ ${((26 * ONE_PASS_PAGE_MS) / 1000).toFixed(0)} s)`,
      ].join("\n"));
    }, 600_000);
  }
});
