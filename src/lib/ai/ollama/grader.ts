import "server-only";
import type * as z from "zod";
import { chunkPageCount } from "@/lib/grading/packet";
import { OLLAMA_MODEL_PREFIX } from "@/lib/ollama-settings";
import type { AiUsage, Confidence } from "@/lib/types";
import { DOCUMENT_CONTEXT } from "../claude";
import { AiError } from "../errors";
import { type AiCallMeta, type CallOptions, type Grader, type PacketReadInput, writesNotes } from "../grader";
import {
  extractionTask, itemRefs, judgingTask, KEY_EXTRACTION_SYSTEM_PROMPT, packetReadingTask, readingTask, renderGradingContext, renderGuidance,
  renderJudgeReading, renderReadingContext, renderScanContext, SCAN_SPLIT_SYSTEM_PROMPT, scanSplitTask,
} from "../prompts";
import { gradeByReading, gradePacketByReading } from "../read-then-mark";
import {
  type CropTranscriptions, CropTranscriptionSchema, judgingWithEmptyNotes, type KeyExtraction, KeyExtractionSchema, outputFormat,
  type PacketReadingOutput, type ReadingOutput, type ScanPages, ScanPagesSchema, SpotProposalSchema,
} from "../schemas";
import {
  cropLabel, nameHintsFor, PROPOSE_SPOTS_SYSTEM_PROMPT, proposeSpotsTask, TRANSCRIBE_SYSTEM_PROMPT, transcribeTask,
} from "../spot-prompts";
import type { OllamaChatResponse, OllamaClient, OllamaMessage } from "./client";
import {
  type CompactJudging, CompactJudgingSchema, type CompactJudgingWithoutNotes, CompactJudgingWithoutNotesSchema, type CompactPacket,
  CompactPacketSchema, type CompactReading, CompactReadingSchema, expandJudging, expandJudgingWithoutNotes, expandPacket,
  expandReading, judgeNumPredict, OLLAMA_JUDGING_SYSTEM_PROMPT, OLLAMA_JUDGING_WITHOUT_NOTES_SYSTEM_PROMPT,
  OLLAMA_PACKET_READING_SYSTEM_PROMPT, OLLAMA_READING_SYSTEM_PROMPT, packetNumPredict, pageRange, readingNumPredict, scanNumPredict,
} from "./compact";
import { classifyOllamaError } from "./errors";
import {
  itemsInRefOrder, mergeKeyExtractions, mergeReadings, offsetScanPages, pageBatches, previousFrom, refProblems, scanPageProblems,
} from "./merge";
import { type PdfRenderer, type RenderedPage, renderPdfPages } from "./render";

// The Grader backed by a vision model running on this computer through Ollama: no API key, nothing leaves the computer, and
// it costs nothing per paper. The same rules as the Claude engines (system prompts, reading and grading context, guidance,
// task text), with each PDF sent as page images, since local models can't read PDFs:
// - a paper is read blind (page images, the items' questions, no answers), marked in code, and its remaining items judged in
//   a text-only call (gradeByReading), as with every engine; small local models are the likeliest to "read" the expected
//   answer into a faint mark, so the reader never sees it. The judge call is skipped when the program marked every item and
//   the assignment's notes are off;
// - reading and judging answers use compact keys and codes (compact.ts), mapped back to the usual shapes: a local model
//   writes its answer a token at a time, so a shorter answer is a faster paper. Each call's output is bounded
//   (options.num_predict) so a model that starts repeating itself stops;
// - a whole-class scan is graded in one pass like with the direct API (readPacketChunk → gradePacketByReading): each chunk is
//   read blind in page batches, so every page is read once and the scan is never split first;
// - at most `pagesPerCall` page images per call: longer keys, papers and scan chunks are read in page batches and merged
//   (merge.ts);
// - the answer must match the JSON schema (Ollama's structured outputs); an unusable answer is sent back once with what is
//   wrong before the call fails.

export interface OllamaGraderConfig {
  model: string;
  numCtx: number;
  /** Pixels of each page image's longer side (ollamaImageEdge: Settings, OLLAMA_IMAGE_MAX_EDGE, or the model family's). */
  imageMaxEdge: number;
  pagesPerCall: number;
  /** Per call to Ollama, after its turn in the queue (see `concurrency`). */
  timeoutMs: number;
  /** Most pages rendered from one PDF. */
  maxPages: number;
  /**
   * Calls sent to Ollama at once by this grader; more wait in this process. Settings → "Papers at a time" (else
   * OLLAMA_CONCURRENCY): the worker grades that many papers at once (Grader.parallel), each making one call at a time.
   */
  concurrency: number;
  /** Crops of written spots per transcription call (OLLAMA_CROPS_PER_CALL); absent: OLLAMA_CROPS_PER_CALL's default. */
  cropsPerCall?: number;
}

export interface OllamaGraderDeps {
  client: OllamaClient;
  cfg: OllamaGraderConfig;
  render?: PdfRenderer;
}

/** Crops of written answer spots transcribed per call (mark detection), unless configured (OLLAMA_CROPS_PER_CALL). */
export const OLLAMA_CROPS_PER_CALL = 8;

/** Per call options object: when its calls waited for their turn at Ollama ([from, to] in performance.now() time). */
const waits = new WeakMap<CallOptions, Array<[number, number]>>();

function noteWait(o: CallOptions, from: number, to: number): void {
  if (to - from < 1) return;
  const list = waits.get(o) ?? [];
  list.push([from, to]);
  if (list.length > 64) list.shift();
  waits.set(o, list);
}

/** How long to wait for Ollama to say what the model can do (thinking or not). */
const CAPABILITIES_TIMEOUT_MS = 10_000;

/** How long Ollama keeps the model loaded between calls. */
export const OLLAMA_KEEP_ALIVE = "30m";

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const CUT_OFF = "That answer was cut off because it was too long. Reply again with the complete JSON object only, minified on one "
  + "line, as short as the rules allow.";

interface CallSpec<T> {
  system: string;
  text: string;
  images: RenderedPage[];
  schema: z.ZodType<T>;
  /** Problems the model must fix (beyond the schema); sent back once. */
  check?: (output: T) => string[];
  /** Ollama's options.num_predict: the most tokens the answer may have (doubled once if it runs out). Unset: unbounded. */
  numPredict?: number;
}

interface CallResult<T> {
  output: T;
  usage: AiUsage;
  /** Problems `check` still found after the retry (the caller repairs what it can). */
  problems: string[];
}

type PacketPaperReading = PacketReadingOutput["papers"][number];

export function createOllamaGrader(d: OllamaGraderDeps): Grader {
  const { cfg, client } = d;
  const render = d.render ?? renderPdfPages;
  const modelId = `${OLLAMA_MODEL_PREFIX}${cfg.model}`;
  const parallel = Math.max(1, Math.floor(cfg.concurrency));
  const cropsPerCall = Math.max(1, Math.floor(cfg.cropsPerCall ?? OLLAMA_CROPS_PER_CALL));
  const acquire = semaphore(parallel);
  let thinking: Promise<boolean> | undefined;

  /**
   * Whether the model reasons before answering (Ollama reports "thinking", e.g. qwen3.6): asked once, then every call turns it
   * off, since the reasoning would be thousands of extra tokens per paper. False when Ollama can't say.
   */
  function canThink(): Promise<boolean> {
    thinking ??= client.capabilities(cfg.model, { signal: AbortSignal.timeout(CAPABILITIES_TIMEOUT_MS) })
      .then((capabilities) => capabilities?.includes("thinking") ?? false, () => false);
    return thinking;
  }

  async function pagesOf(pdf: Uint8Array, o: CallOptions): Promise<RenderedPage[]> {
    return render(pdf, { maxEdge: cfg.imageMaxEdge, maxPages: cfg.maxPages, signal: o.signal });
  }

  /** One request, plus one retry when the answer isn't usable (or was cut off at num_predict). Rejects with AiError. */
  async function call<T>(spec: CallSpec<T>, o: CallOptions): Promise<CallResult<T>> {
    const queuedAt = performance.now();
    const release = await acquire(o.signal);
    noteWait(o, queuedAt, performance.now());
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let usage = NO_USAGE;
    let numPredict = spec.numPredict === undefined ? undefined : Math.max(1, Math.min(Math.round(spec.numPredict), cfg.numCtx));
    const noThinking = (await canThink()) ? { think: false } : {};
    const messages: OllamaMessage[] = [
      { role: "system", content: spec.system },
      { role: "user", content: spec.text, images: spec.images.map((page) => Buffer.from(page.png).toString("base64")) },
    ];
    try {
      for (let attempt = 1; ; attempt++) {
        let res: OllamaChatResponse;
        try {
          res = await client.chat({
            model: cfg.model,
            messages,
            format: outputFormat(spec.schema).schema,
            options: { num_ctx: cfg.numCtx, temperature: 0, ...(numPredict === undefined ? {} : { num_predict: numPredict }) },
            keep_alive: OLLAMA_KEEP_ALIVE,
            stream: false,
            ...noThinking,
          }, { signal });
        } catch (e) {
          throw classifyOllamaError(e, {
            baseUrl: client.baseUrl, model: cfg.model, numCtx: cfg.numCtx, timeoutMs: cfg.timeoutMs,
            aborted: o.signal?.aborted ?? false, timedOut: timeout.aborted,
          });
        }
        usage = addUsage(usage, res);
        const billed = { servedModel: modelId, usage };
        if (res.done_reason === "length") {
          const hitBudget = numPredict !== undefined && (res.eval_count ?? numPredict) >= numPredict;
          if (!hitBudget) {
            throw new AiError("request_too_large", `The model ran out of room (context size ${cfg.numCtx}) before finishing its answer. `
              + "Raise the context size in Settings → Grader, or lower OLLAMA_PAGES_PER_CALL.", { retryable: false, billed });
          }
          if (attempt === 2) {
            throw new AiError("max_tokens", `The model's answer went on past ${numPredict} tokens.`, { retryable: true, billed });
          }
          // Once more with twice the room (within the context), told to keep it short.
          numPredict = Math.min(numPredict! * 2, cfg.numCtx);
          messages.push({ role: "assistant", content: res.message.content }, { role: "user", content: CUT_OFF });
          continue;
        }
        const parsed = parseAnswer(res.message.content, spec.schema);
        const problems = parsed.ok ? (spec.check?.(parsed.output) ?? []) : [parsed.problem];
        if (parsed.ok && (problems.length === 0 || attempt === 2)) return { output: parsed.output, usage, problems };
        if (attempt === 2) {
          throw new AiError("invalid_output", `The model's answer wasn't usable twice: ${problems.join("; ")}`, { retryable: true, billed });
        }
        messages.push(
          { role: "assistant", content: res.message.content },
          {
            role: "user",
            content: `That answer can't be used: ${problems.join("; ")}. Reply again with the complete, corrected JSON object only, `
              + "following the schema.",
          },
        );
      }
    } finally {
      release();
    }
  }

  /**
   * The step's time: from `startedAt` until now, less the time its calls waited for their turn at Ollama (papers prepared
   * ahead wait there while another paper's call runs), so a paper's read time is its own work.
   */
  function meta(usage: AiUsage, startedAt: number, o: CallOptions): AiCallMeta {
    const end = performance.now();
    const waited = (waits.get(o) ?? []).reduce((sum, [from, to]) => sum + Math.max(0, Math.min(to, end) - Math.max(from, startedAt)), 0);
    return {
      requestedModel: modelId, servedModel: modelId, fallbackUsed: false, stopReason: "end_turn", usage,
      durationMs: Math.max(0, Math.round(end - startedAt - waited)),
    };
  }

  /**
   * READ one chunk of a whole-class scan, blind, in page batches of at most `pagesPerCall` pages (whole papers when the key
   * tells a paper's length). Each batch finds the papers on its pages; a paper the batch's last paper may continue is read
   * again from its first page with the next batch, or, when it fills the whole batch, joined with its continuation. Pages
   * are chunk pages, as interpretChunk expects.
   */
  async function readPacketChunk(input: PacketReadInput, o: CallOptions = {}): Promise<{ output: PacketReadingOutput; meta: AiCallMeta }> {
    const startedAt = performance.now();
    const pages = await pagesOf(input.chunkPdf, o);
    const n = pages.length;
    const refs = itemRefs(input.items.length);
    const context = renderReadingContext(input);
    const size = chunkPageCount({ keyPageCount: input.keyPageCount, maxPages: cfg.pagesPerCall });
    const papers: PacketPaperReading[] = [];
    const skipped: PacketReadingOutput["skipped_pages"] = [];
    /** A paper that filled its whole batch and may go on: joined with the next batch's first paper when that continues it. */
    let open: PacketPaperReading | null = null;
    let usage = NO_USAGE;
    for (let start = 1; start <= n;) {
      const last = Math.min(n, start + size - 1);
      const count = last - start + 1;
      const result = await call({
        system: OLLAMA_PACKET_READING_SYSTEM_PROMPT,
        text: [
          context,
          `The SCANNED PAGES are attached as ${imageCount(count)}, in scan order (image 1 is page 1). ${DOCUMENT_CONTEXT.scan}`,
          packetReadingTask({
            firstPage: input.firstPage + start - 1, chunkPageCount: count, totalPages: input.totalPages, keyPageCount: input.keyPageCount,
            refs,
          }),
        ].join("\n\n"),
        images: pages.slice(start - 1, last),
        schema: CompactPacketSchema,
        check: (out: CompactPacket) => packetProblems(out, count, refs),
        numPredict: packetNumPredict(input.items, count, input.keyPageCount),
      }, o);
      usage = sumUsage(usage, result.usage);
      const expanded = expandPacket(result.output, start - 1);
      const batch = batchPapers(expanded.papers, start, last).map((p) => itemsInRefOrder(p, refs));

      if (open) {
        const first = batch[0];
        if (first && first.first_page === start && first.continues_from_previous_chunk) batch[0] = joinPapers(open, first, refs);
        else papers.push(open);
        open = null;
      }
      let next = last + 1;
      const tail = batch.at(-1);
      if (tail && tail.may_continue_after_chunk && last < n && tail.last_page === last) {
        batch.pop();
        if (tail.first_page > start) next = tail.first_page; // read again, whole, with the next batch
        else open = tail;
      }
      papers.push(...batch);
      for (const page of expanded.skipped_pages) {
        if (page.page >= start && page.page < next && !skipped.some((s) => s.page === page.page)) skipped.push(page);
      }
      start = next;
    }
    if (open) papers.push(open);
    return { output: { papers, skipped_pages: skipped }, meta: meta(usage, startedAt, o) };
  }

  const grader: Grader = {
    mode: "claude",
    engine: "ollama",
    parallel,
    cropsPerCall,

    async extractKey(input, o = {}) {
      const startedAt = performance.now();
      const pages = await pagesOf(input.keyPdf, o);
      const batches = pageBatches(pages.length, cfg.pagesPerCall);
      const parts: KeyExtraction[] = [];
      let usage = NO_USAGE;
      for (const [first, last] of batches) {
        const where = batches.length === 1
          ? `The ANSWER KEY is attached as ${imageCount(pages.length)}, in page order (image 1 is page 1).`
          : `The ANSWER KEY has ${pages.length} pages; this message shows pages ${first}–${last} as ${imageCount(last - first + 1)} `
            + `(image 1 is page ${first}). The other pages are read separately: extract only the items on these pages, and give each `
            + "item's page as its page number in the whole key.";
        const result = await call({
          system: KEY_EXTRACTION_SYSTEM_PROMPT,
          text: `${where}\n\n${extractionTask(input.assignmentTitle, input.teacherNotes, input.pageCount)}`,
          images: pages.slice(first - 1, last),
          schema: KeyExtractionSchema,
        }, o);
        parts.push(result.output);
        usage = sumUsage(usage, result.usage);
      }
      return { output: mergeKeyExtractions(parts), meta: meta(usage, startedAt, o) };
    },

    async readSubmission(input, o = {}) {
      const startedAt = performance.now();
      const pages = await pagesOf(input.studentPdf, o);
      const refs = itemRefs(input.items.length);
      const context = renderReadingContext(input);
      const batches = pageBatches(pages.length, cfg.pagesPerCall);
      const parts: ReadingOutput[] = [];
      let usage = NO_USAGE;
      for (const [first, last] of batches) {
        const count = last - first + 1;
        const where = batches.length === 1
          ? `The STUDENT SUBMISSION is attached as ${imageCount(count)}, in page order (image 1 is page 1). ${DOCUMENT_CONTEXT.student}`
          : `The STUDENT SUBMISSION has ${pages.length} pages; this message shows pages ${first}–${last} as ${imageCount(count)} `
            + `(image 1 is page ${first}). ${DOCUMENT_CONTEXT.student} The other pages are read separately. For an item whose `
            + "answer is not on these pages, return attempt \"n\", legibility \"n\", confidence \"h\", and an empty answer and marks.";
        const result = await call({
          system: OLLAMA_READING_SYSTEM_PROMPT,
          text: [context, where, readingTask(count, refs)].join("\n\n"),
          images: pages.slice(first - 1, last),
          schema: CompactReadingSchema,
          check: (out: CompactReading) => refProblems(withRefs(out.i), refs),
          numPredict: readingNumPredict(input.items),
        }, o);
        // The model isn't asked for pages: an item read in this batch is on its pages.
        parts.push(itemsInRefOrder(expandReading(result.output, pageRange(first, last)), refs));
        usage = sumUsage(usage, result.usage);
      }
      return { output: mergeReadings(parts, refs), meta: meta(usage, startedAt, o) };
    },

    async judgeSubmission(input, o = {}) {
      const startedAt = performance.now();
      const writeNotes = writesNotes(input);
      const allRefs = input.reading.map((r) => r.ref);
      const judgeRefs = input.reading.filter((r) => r.mark === null).map((r) => r.ref);
      const expected = writeNotes ? allRefs : judgeRefs;
      const spec = {
        text: [
          renderGradingContext({ assignment: input.assignment, teacherNotes: input.teacherNotes, sections: input.sections, items: input.items }),
          renderGuidance(input.guidance, input.items),
          renderJudgeReading(input.reading.map(({ ref, item, mark }) => ({ ref, reading: item, mark })), input.unmatchedWork),
          judgingTask({ allRefs, judgeRefs, writeNotes }),
        ].filter((block) => block !== "").join("\n\n"),
        // Text only: the judge never sees the pages.
        images: [],
        numPredict: judgeNumPredict({ judged: judgeRefs.length, all: allRefs.length, writeNotes }),
      };
      if (writeNotes) {
        const result = await call<CompactJudging>({
          ...spec, system: OLLAMA_JUDGING_SYSTEM_PROMPT, schema: CompactJudgingSchema,
          check: (out) => refProblems(withRefs(out.i), expected),
        }, o);
        return { output: itemsInRefOrder(expandJudging(result.output), expected), meta: meta(result.usage, startedAt, o) };
      }
      const result = await call<CompactJudgingWithoutNotes>({
        ...spec, system: OLLAMA_JUDGING_WITHOUT_NOTES_SYSTEM_PROMPT, schema: CompactJudgingWithoutNotesSchema,
        check: (out) => refProblems(withRefs(out.i), expected),
      }, o);
      return {
        output: judgingWithEmptyNotes(itemsInRefOrder(expandJudgingWithoutNotes(result.output), expected)),
        meta: meta(result.usage, startedAt, o),
      };
    },

    gradeSubmission: (input, o) => gradeByReading(grader, input, o),

    async readScanPages(input, o = {}) {
      const startedAt = performance.now();
      const pages = await pagesOf(input.chunkPdf, o);
      const context = renderScanContext(input);
      const read: ScanPages["pages"] = [];
      let previousPage = input.previousPage;
      let usage = NO_USAGE;
      for (const [first, last] of pageBatches(pages.length, cfg.pagesPerCall)) {
        const count = last - first + 1;
        const scanFirst = input.firstPage + first - 1;
        const result = await call({
          system: SCAN_SPLIT_SYSTEM_PROMPT,
          text: [
            context,
            `The SCANNED PAGES are attached as ${imageCount(count)}, in scan order (image 1 is chunk_page 1). ${DOCUMENT_CONTEXT.scan}`,
            scanSplitTask(scanFirst, count, input.totalPages, previousPage),
          ].join("\n\n"),
          images: pages.slice(first - 1, last),
          schema: ScanPagesSchema,
          check: (out: ScanPages) => scanPageProblems(out, count),
          numPredict: scanNumPredict(count),
        }, o);
        const batch = offsetScanPages(result.output, count, first - 1);
        read.push(...batch);
        usage = sumUsage(usage, result.usage);
        // The next batch is judged against this one's last page, when the model described it.
        previousPage = batch.at(-1)?.chunk_page === last ? previousFrom(batch, input.firstPage) : null;
      }
      return { output: { pages: read }, meta: meta(usage, startedAt, o) };
    },

    readPacketChunk,
    gradePacketChunk: (input, o) => gradePacketByReading(grader, input, o),

    // Mark detection: only crops of the student's written answer spots, a few per call, each image labelled with its id.
    async transcribeCrops(input, o = {}) {
      const startedAt = performance.now();
      const crops: CropTranscriptions["crops"] = [];
      let usage = NO_USAGE;
      for (let k = 0; k < input.crops.length; k += cropsPerCall) {
        const batch = input.crops.slice(k, k + cropsPerCall);
        const ids = batch.map((c) => c.id);
        const result = await call({
          system: TRANSCRIBE_SYSTEM_PROMPT,
          text: [
            batch.map((c, n) => `Image ${n + 1}: ${cropLabel(c.id, c.kind).replace(/:$/, "")}.`).join("\n"),
            transcribeTask(ids, { nameHints: nameHintsFor(batch, input.nameHints) }),
          ].join("\n\n"),
          images: batch.map((c) => ({ png: c.png, width: c.width, height: c.height })),
          schema: CropTranscriptionSchema,
          check: (out: CropTranscriptions) => {
            const missing = ids.filter((id) => !out.crops.some((c) => c.id.trim().toUpperCase() === id.toUpperCase()));
            return missing.length > 0 ? [`crops must have one entry for each id (${ids.join(", ")}); missing: ${missing.join(", ")}`] : [];
          },
          numPredict: 100 + 150 * batch.length,
        }, o);
        crops.push(...result.output.crops);
        usage = sumUsage(usage, result.usage);
      }
      return { output: { crops }, meta: meta(usage, startedAt, o) };
    },

    async proposeSpots(input, o = {}) {
      const startedAt = performance.now();
      const result = await call({
        system: PROPOSE_SPOTS_SYSTEM_PROMPT,
        text: proposeSpotsTask({ width: input.page.width, height: input.page.height, pageNumber: input.pageNumber, itemLabels: input.itemLabels }),
        images: [input.page],
        schema: SpotProposalSchema,
        numPredict: 6_000,
      }, o);
      return { output: result.output, meta: meta(result.usage, startedAt, o) };
    },
  };
  return grader;
}

function withRefs(items: Array<{ r: string }>): { items: Array<{ ref: string }> } {
  return { items: items.map((item) => ({ ref: item.r })) };
}

/** What a scan batch's answer must fix: each paper's pages within the batch, and one entry per ref for every paper. */
export function packetProblems(out: CompactPacket, count: number, refs: string[]): string[] {
  const problems: string[] = [];
  const outside = out.p.findIndex((p) => [p.f, p.e].some((page) => Math.round(page) < 1 || Math.round(page) > count));
  if (outside !== -1) problems.push(`papers entry ${outside + 1}: f and e must be pages from 1 to ${count}`);
  const wrongRefs = out.p.findIndex((p) => refProblems(withRefs(p.i), refs).length > 0);
  if (wrongRefs !== -1) problems.push(`papers entry ${wrongRefs + 1}: ${refProblems(withRefs(out.p[wrongRefs].i), refs).join("; ")}`);
  return problems;
}

/** A batch's papers in page order, each kept within the batch (`start`…`last`, chunk pages), without overlaps. */
function batchPapers(papers: PacketPaperReading[], start: number, last: number): PacketPaperReading[] {
  const clamp = (page: number) => Math.min(Math.max(page, start), last);
  const sorted = papers
    .map((p) => ({ ...p, first_page: clamp(p.first_page), last_page: clamp(p.last_page) }))
    .sort((a, b) => a.first_page - b.first_page || a.last_page - b.last_page);
  const kept: PacketPaperReading[] = [];
  for (const p of sorted) {
    const prev = kept.at(-1);
    if (prev && p.last_page <= prev.last_page) continue;
    kept.push(prev && p.first_page <= prev.last_page ? { ...p, first_page: prev.last_page + 1 } : p);
  }
  return kept;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** A paper read across two batches: its pages, the edges of both, and per item the reading from the batch where it was answered. */
function joinPapers(a: PacketPaperReading, b: PacketPaperReading, refs: string[]): PacketPaperReading {
  const reading = mergeReadings([readingOf(a), readingOf(b)], refs);
  return {
    first_page: a.first_page,
    last_page: b.last_page,
    continues_from_previous_chunk: a.continues_from_previous_chunk,
    may_continue_after_chunk: b.may_continue_after_chunk,
    boundary_confidence: CONFIDENCE_RANK[a.boundary_confidence] <= CONFIDENCE_RANK[b.boundary_confidence]
      ? a.boundary_confidence
      : b.boundary_confidence,
    ...reading,
  };
}

function readingOf(p: PacketPaperReading): ReadingOutput {
  return { student: p.student, document_check: p.document_check, items: p.items, integrity: p.integrity, unmatched_work: p.unmatched_work };
}

function imageCount(n: number): string {
  return n === 1 ? "1 image" : `${n} images`;
}

function addUsage(total: AiUsage, res: OllamaChatResponse): AiUsage {
  return {
    ...total,
    inputTokens: total.inputTokens + (res.prompt_eval_count ?? 0),
    outputTokens: total.outputTokens + (res.eval_count ?? 0),
  };
}

function sumUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

type Parsed<T> = { ok: true; output: T } | { ok: false; problem: string };

/** The answer as JSON matching `schema`. Tolerates a ```json fence around it, which some models add. */
export function parseAnswer<T>(content: string, schema: z.ZodType<T>): Parsed<T> {
  const text = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  if (text === "") return { ok: false, problem: "the answer was empty" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "the answer was not valid JSON" };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, output: result.data };
  const issue = result.error.issues[0];
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return { ok: false, problem: `the answer does not match the schema at ${path}: ${issue.message}` };
}

/** At most `n` holders at once; waiting callers go in order. An abort while waiting rejects with AiError("aborted"). */
function semaphore(n: number): (signal?: AbortSignal) => Promise<() => void> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      waiting.shift()?.();
    };
  };
  return (signal) => {
    if (signal?.aborted) return Promise.reject(new AiError("aborted", "The call to Ollama was stopped.", { retryable: true }));
    if (active < n) {
      active++;
      return Promise.resolve(releaser());
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", onAbort);
        active++;
        resolve(releaser());
      };
      const onAbort = () => {
        const at = waiting.indexOf(go);
        if (at !== -1) waiting.splice(at, 1);
        reject(new AiError("aborted", "The call to Ollama was stopped.", { retryable: true }));
      };
      waiting.push(go);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}
