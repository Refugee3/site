import "server-only";
import type * as z from "zod";
import { OLLAMA_MODEL_PREFIX } from "@/lib/ollama-settings";
import type { AiUsage } from "@/lib/types";
import { DOCUMENT_CONTEXT } from "../claude";
import { AiError } from "../errors";
import { type AiCallMeta, type CallOptions, type Grader, writesNotes } from "../grader";
import {
  extractionTask, GRADING_SYSTEM_PROMPT, gradingTask, itemRefs, KEY_EXTRACTION_SYSTEM_PROMPT, renderGradingContext, renderGuidance,
  renderScanContext, SCAN_SPLIT_SYSTEM_PROMPT, scanSplitTask,
} from "../prompts";
import {
  type GradingOutput, GradingOutputSchema, type GradingOutputWithoutNotes, GradingOutputWithoutNotesSchema, type KeyExtraction,
  KeyExtractionSchema, outputFormat, type ScanPages, ScanPagesSchema, withEmptyNotes,
} from "../schemas";
import type { OllamaChatResponse, OllamaClient, OllamaMessage } from "./client";
import { classifyOllamaError } from "./errors";
import {
  itemsInRefOrder, mergeGradings, mergeKeyExtractions, offsetScanPages, pageBatches, previousFrom, refProblems, scanPageProblems,
} from "./merge";
import { type PdfRenderer, type RenderedPage, renderPdfPages } from "./render";

// The Grader backed by a vision model running on this computer through Ollama: no API key, nothing leaves the computer, and
// it costs nothing per paper. The same prompts as the Claude engines (system prompts, grading context, guidance, task text),
// with each PDF sent as page images, since local models can't read PDFs:
// - one paper per call (no one-pass grading of whole-class scans: gradePacketChunk is absent, so such a scan is split first and
//   each paper graded on its own, as with the hosted agent);
// - at most `pagesPerCall` page images per call: longer keys, papers and scan chunks are read in page batches and merged
//   (merge.ts);
// - the teacher's key PDF is not sent with papers: the structured key (the authority anyway) is, which fits a small context;
// - the answer must match the JSON schema (Ollama's structured outputs); an unusable answer is sent back once with what is
//   wrong before the call fails.

export interface OllamaGraderConfig {
  model: string;
  numCtx: number;
  imageMaxEdge: number;
  pagesPerCall: number;
  /** Per call to Ollama, after its turn in the queue (see `concurrency`). */
  timeoutMs: number;
  /** Most pages rendered from one PDF. */
  maxPages: number;
  /** Calls sent to Ollama at once by this grader; more wait in this process. */
  concurrency: number;
}

export interface OllamaGraderDeps {
  client: OllamaClient;
  cfg: OllamaGraderConfig;
  render?: PdfRenderer;
}

/** How long Ollama keeps the model loaded between calls. */
export const OLLAMA_KEEP_ALIVE = "30m";

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface CallSpec<T> {
  system: string;
  text: string;
  images: RenderedPage[];
  schema: z.ZodType<T>;
  /** Problems the model must fix (beyond the schema); sent back once. */
  check?: (output: T) => string[];
}

interface CallResult<T> {
  output: T;
  usage: AiUsage;
  /** Problems `check` still found after the retry (the caller repairs what it can). */
  problems: string[];
}

export function createOllamaGrader(d: OllamaGraderDeps): Grader {
  const { cfg, client } = d;
  const render = d.render ?? renderPdfPages;
  const modelId = `${OLLAMA_MODEL_PREFIX}${cfg.model}`;
  const acquire = semaphore(Math.max(1, cfg.concurrency));

  async function pagesOf(pdf: Uint8Array, o: CallOptions): Promise<RenderedPage[]> {
    return render(pdf, { maxEdge: cfg.imageMaxEdge, maxPages: cfg.maxPages, signal: o.signal });
  }

  /** One request, plus one retry when the answer isn't usable. Rejects with AiError. */
  async function call<T>(spec: CallSpec<T>, o: CallOptions): Promise<CallResult<T>> {
    const release = await acquire(o.signal);
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let usage = NO_USAGE;
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
            options: { num_ctx: cfg.numCtx, temperature: 0 },
            keep_alive: OLLAMA_KEEP_ALIVE,
            stream: false,
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
          throw new AiError("request_too_large", `The model ran out of room (context size ${cfg.numCtx}) before finishing its answer. `
            + "Raise the context size in Settings → Grader, or lower OLLAMA_PAGES_PER_CALL.", { retryable: false, billed });
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

  function meta(usage: AiUsage, startedAt: number): AiCallMeta {
    return {
      requestedModel: modelId, servedModel: modelId, fallbackUsed: false, stopReason: "end_turn", usage,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  return {
    mode: "claude",
    engine: "ollama",

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
      return { output: mergeKeyExtractions(parts), meta: meta(usage, startedAt) };
    },

    async gradeSubmission(input, o = {}) {
      const startedAt = performance.now();
      const pages = await pagesOf(input.studentPdf, o);
      const refs = itemRefs(input.items.length);
      const writeNotes = writesNotes(input);
      const guidance = renderGuidance(input.guidance, input.items);
      const context = renderGradingContext({
        assignment: input.assignment, teacherNotes: input.teacherNotes, sections: input.sections, items: input.items,
      });
      const batches = pageBatches(pages.length, cfg.pagesPerCall);
      const parts: GradingOutputWithoutNotes[] = [];
      let usage = NO_USAGE;
      for (const [first, last] of batches) {
        const count = last - first + 1;
        const where = batches.length === 1
          ? `The STUDENT SUBMISSION is attached as ${imageCount(count)}, in page order (image 1 is page 1). ${DOCUMENT_CONTEXT.student}`
          : `The STUDENT SUBMISSION has ${pages.length} pages; this message shows pages ${first}–${last} as ${imageCount(count)} `
            + `(image 1 is page ${first}). ${DOCUMENT_CONTEXT.student} The other pages are graded separately. Give pages as page `
            + "numbers of the whole submission. For an item whose answer is not on these pages, return attempt \"none\", correctness "
            + "\"no_answer\", legibility \"no_writing\", confidence \"high\", review_reason \"none\", pages [] and an empty student_answer.";
        const spec = {
          system: GRADING_SYSTEM_PROMPT,
          text: [context, guidance, where, gradingTask(count, refs, writeNotes)].filter((block) => block !== "").join("\n\n"),
          images: pages.slice(first - 1, last),
          check: (out: GradingOutputWithoutNotes) => refProblems(out, refs),
        };
        const result = writeNotes
          ? await call<GradingOutput>({ ...spec, schema: GradingOutputSchema }, o)
          : await call<GradingOutputWithoutNotes>({ ...spec, schema: GradingOutputWithoutNotesSchema }, o);
        parts.push(itemsInRefOrder(result.output, refs));
        usage = sumUsage(usage, result.usage);
      }
      const merged = mergeGradings(parts, refs);
      const output = writeNotes ? (merged as GradingOutput) : withEmptyNotes(merged);
      return { output, refs, keyPdfIncluded: false, meta: meta(usage, startedAt) };
    },

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
        }, o);
        const batch = offsetScanPages(result.output, count, first - 1);
        read.push(...batch);
        usage = sumUsage(usage, result.usage);
        // The next batch is judged against this one's last page, when the model described it.
        previousPage = batch.at(-1)?.chunk_page === last ? previousFrom(batch, input.firstPage) : null;
      }
      return { output: { pages: read }, meta: meta(usage, startedAt) };
    },
  };
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
