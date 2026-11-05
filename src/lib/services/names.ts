import "server-only";
import * as z from "zod";
import { type ChatGptClient, createChatGptClient, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from "@/lib/ai/chatgpt/client";
import { checkNamesHidden, findNames, type NameMark, type NamesFound, readScanPagesWithChatGpt } from "@/lib/ai/chatgpt/names";
import type { Grader } from "@/lib/ai/grader";
import { AiError } from "@/lib/ai/errors";
import { maskApiKey } from "@/lib/ai/api-key";
import { renderPdfPages } from "@/lib/ai/ollama/render";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { listSections } from "@/lib/db/repos/assignments";
import { getStoredNamesSettings, saveStoredNamesSettings } from "@/lib/db/repos/names";
import { listAnonIds, saveNamesHidden } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { parseInput } from "@/lib/http/validation";
import { coverPages, newAnonId, pagesToPdf, type PageImage } from "@/lib/names/cover";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { rosterNameHints } from "@/lib/services/rosters";
import { readDataFile, writeFileAtomic } from "@/lib/storage/files";
import { namesHiddenPdfRel } from "@/lib/storage/paths";
import type { AiUsage, NamesHiddenInfo, Submission } from "@/lib/types";

// "Hide student names with ChatGPT" (Settings → Student names). When it is on, no grading AI (Ollama or Claude) ever sees a
// student's name: before a paper is graded, ChatGPT (the school's account) reads the name and finds every place a name, ID,
// email or signature is written; the app covers those places with the paper's anonymous ID and ChatGPT checks the result.
// Only that copy is graded, and the name ChatGPT read is what the results show next to the ID. A class scan is split with
// ChatGPT too (src/lib/jobs/handlers.ts). The original paper stays as uploaded, for the teacher.

/** Page image size sent to ChatGPT and kept for the covered copy (pixels of the longer side). */
const PAGE_EDGE = 1600;
/** Rounds of "check, cover what's left" after the first cover. */
const CHECK_ROUNDS = 2;

export const NAMES_STILL_VISIBLE = "ChatGPT couldn't confirm that every name on this paper was covered, so it wasn't sent to the "
  + "grading AI. Grade it by hand, or upload a clearer copy.";

export interface NamesView {
  enabled: boolean;
  keyMasked: string | null;
  baseUrl: string;
  model: string;
  /** On, but there's no usable key: papers wait. */
  missingKey: boolean;
}

export function getNamesView(): NamesView {
  const s = getStoredNamesSettings();
  return {
    enabled: s.enabled,
    keyMasked: s.apiKeyMasked,
    baseUrl: s.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    model: s.model ?? DEFAULT_OPENAI_MODEL,
    missingKey: s.enabled && getConfig().aiMode !== "fake" && chatGptClient() === null,
  };
}

/** Whether papers must have their names hidden by ChatGPT before any grading AI sees them. */
export function namesHiddenRequired(): boolean {
  return getStoredNamesSettings().enabled;
}

const NamesSettingsSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().trim().max(500, "That key is too long."),
  baseUrl: z.string().trim().max(500).refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "Enter an address starting with https://"),
  model: z.string().trim().max(100).regex(/^[\w.:/-]*$/, "Use the model's name, like gpt-5-mini."),
});

/** Settings → Student names. An empty key keeps the saved one. Turning it on needs a key. */
export function saveNamesSettings(input: unknown): void {
  const s = parseInput(NamesSettingsSchema, input);
  const stored = getStoredNamesSettings();
  if (s.enabled && s.apiKey === "" && stored.apiKeyCiphertext === null && getConfig().aiMode !== "fake") {
    throw new AppError("validation", "Some fields need fixing.", { fieldErrors: { apiKey: ["Enter the school's ChatGPT API key."] } });
  }
  saveStoredNamesSettings({
    enabled: s.enabled,
    baseUrl: s.baseUrl === "" ? null : s.baseUrl.replace(/\/+$/, ""),
    model: s.model === "" ? null : s.model,
    key: s.apiKey === "" ? undefined : { ciphertext: encryptSecret(s.apiKey, "openai-api-key"), masked: maskApiKey(s.apiKey) },
  });
}

export function removeNamesKey(): void {
  const s = getStoredNamesSettings();
  saveStoredNamesSettings({ enabled: false, baseUrl: s.baseUrl, model: s.model, key: null });
}

/** The school's ChatGPT from the saved settings (the practice ChatGPT in AI_MODE=fake); null without a usable key. */
export function chatGptClient(): ChatGptClient | null {
  if (getConfig().aiMode === "fake") return fakeChatGpt();
  const s = getStoredNamesSettings();
  const apiKey = s.apiKeyCiphertext ? decryptSecret(s.apiKeyCiphertext, "openai-api-key") : null;
  if (!apiKey) return null;
  return createChatGptClient({ apiKey, baseUrl: s.baseUrl ?? DEFAULT_OPENAI_BASE_URL, model: s.model ?? DEFAULT_OPENAI_MODEL });
}

/** Settings' "Test": one small call with the saved key, address and model. */
export async function testChatGpt(): Promise<string> {
  const client = chatGptClient();
  if (!client) throw new AppError("invalid_state", "Save the ChatGPT API key first.");
  try {
    await client.json({
      system: "Answer with the JSON object asked for.", text: "Reply with ok set to true.", images: [], name: "test",
      schema: z.object({ ok: z.boolean() }), maxTokens: 200,
    });
  } catch (e) {
    throw new AppError("invalid_state", e instanceof Error ? e.message : String(e));
  }
  return `ChatGPT (${client.model}) answered.`;
}

/** A class scan's pages read by ChatGPT (where each paper starts and whose it is), in place of the grading AI's reader. */
export function chatGptScanReader(): Grader["readScanPages"] {
  return async (input, o = {}) => {
    const client = chatGptClient();
    if (!client) {
      throw new AiError("auth", "Splitting a scan with names hidden needs the school's ChatGPT API key.", {
        retryable: false, pauseWorker: true, pauseReason: "Set up ChatGPT in Settings → Student names: scans wait until it can read them.",
      });
    }
    const startedAt = performance.now();
    const rendered = await renderPdfPages(input.chunkPdf, { maxEdge: PAGE_EDGE, maxPages: getConfig().maxScanPages, signal: o.signal });
    const result = await readScanPagesWithChatGpt(client, input, rendered.map((p) => ({ bytes: p.png, mime: "image/png" as const })), {
      signal: o.signal,
    });
    return {
      output: result.output,
      meta: {
        requestedModel: client.model, servedModel: client.model, fallbackUsed: false, stopReason: "end_turn", usage: result.usage,
        durationMs: Math.round(performance.now() - startedAt),
      },
    };
  };
}

export interface HiddenPaper {
  /** The covered copy, for the grading AI. */
  pdf: Uint8Array;
  anonId: string;
  info: NamesHiddenInfo;
  /** ChatGPT's tokens for this paper (none when the copy already existed). */
  usage: AiUsage | null;
  model: string | null;
}

/**
 * The paper with its names covered: the stored copy when there is one, else ChatGPT finds the names, the app covers them
 * with the paper's anonymous ID, and ChatGPT checks the copy (covering anything it still finds, up to CHECK_ROUNDS). Throws
 * AiError when ChatGPT can't be reached or answers badly, and AppError("names_visible") when a name still shows.
 */
export async function hidePaperNames(s: Submission, o: { signal?: AbortSignal; client?: ChatGptClient | null } = {}): Promise<HiddenPaper> {
  if (s.namesHiddenPdfPath && s.anonId && s.namesHidden) {
    const pdf = await readDataFile(s.namesHiddenPdfPath).catch(() => null);
    if (pdf) return { pdf, anonId: s.anonId, info: s.namesHidden, usage: null, model: null };
  }
  const client = o.client === undefined ? chatGptClient() : o.client;
  if (!client) {
    throw new AiError("auth", "Hiding student names needs the school's ChatGPT API key.", {
      retryable: false, pauseWorker: true, pauseReason: "Set up ChatGPT in Settings → Student names: papers wait until names can be hidden.",
    });
  }
  const original = await readDataFile(s.pdfPath);
  const rendered = await renderPdfPages(original, { maxEdge: PAGE_EDGE, maxPages: getConfig().maxPages, signal: o.signal });
  const pages: PageImage[] = rendered.map((p) => ({ bytes: p.png, width: p.width, height: p.height }));
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const add = (u: AiUsage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
  };

  const found = await findNames(client, pages.map(asImage), {
    nameHints: rosterNameHints(s.assignmentId), sections: listSections(s.assignmentId).map((x) => x.label), signal: o.signal,
  });
  add(found.usage);
  const anonId = s.anonId ?? newAnonId(listAnonIds(s.assignmentId));
  let covered = await coverPages(pages, found.output.marks, anonId);
  let count = found.output.marks.length;
  let left: NameMark[] = [];
  for (let round = 0; round < CHECK_ROUNDS; round++) {
    const check = await checkNamesHidden(client, covered.map(asImage), { signal: o.signal });
    add(check.usage);
    left = check.output.visible ? check.output.marks : [];
    if (left.length === 0 && !check.output.visible) break;
    covered = await coverPages(covered, left, anonId);
    count += left.length;
    if (round === CHECK_ROUNDS - 1) {
      // The last cover isn't checked again: a name the checker still saw twice is reported, not graded.
      throw new AppError("names_visible", NAMES_STILL_VISIBLE);
    }
  }

  const pdf = await pagesToPdf(covered);
  const rel = namesHiddenPdfRel(s.assignmentId, s.id);
  await writeFileAtomic(rel, pdf);
  const info = infoFrom(found.output, count);
  saveNamesHidden(s.id, { anonId, pdfPath: rel, info });
  return { pdf, anonId, info, usage, model: client.model };
}

function infoFrom(found: NamesFound, covered: number): NamesHiddenInfo {
  const name = found.student.name?.trim() || null;
  return {
    name, nameConfidence: name ? found.student.name_confidence : "low", sectionRaw: found.student.section_raw?.trim() || null,
    multipleStudents: found.student.multiple_students_detected, covered, at: now(),
  };
}

function asImage(p: PageImage) {
  // PNG straight from the renderer, JPEG once covered.
  const png = p.bytes[0] === 0x89 && p.bytes[1] === 0x50;
  return { bytes: p.bytes, mime: png ? ("image/png" as const) : ("image/jpeg" as const) };
}

/**
 * The practice ChatGPT (AI_MODE=fake): it "finds" a name at the top of page 1 and reports every copy clean. It reads nothing,
 * so the names it gives are placeholders.
 */
function fakeChatGpt(): ChatGptClient {
  return {
    model: "fake-chatgpt",
    async json(call) {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const digest = call.images.length > 0 ? call.images[0].bytes.length.toString(36).slice(-4) : "0000";
      const answer: unknown = call.name === "names_found"
        ? {
          student: { name: `Practice Student ${digest.toUpperCase()}`, name_confidence: "high", section_raw: null, multiple_students_detected: false },
          marks: [{ page: 1, kind: "name", x_min: 40, y_min: 20, x_max: 520, y_max: 80 }],
        }
        : call.name === "names_left"
          ? { visible: false, marks: [] }
          : call.name === "scan_pages"
            ? {
              // Every page starts a paper: the teacher checks the split, as with the practice grader.
              pages: call.images.map((img, i) => ({
                chunk_page: i + 1, kind: "student_work", starts_new_paper: true, student_name: `Practice Student ${i + 1}`,
                section_raw: null, page_marker: null, worksheet_page: 1, confidence: "high", note: "",
              })),
            }
            : { ok: true };
      const parsed = call.schema.safeParse(answer);
      if (!parsed.success) throw new AiError("invalid_output", "The practice ChatGPT can't answer this.", { retryable: false });
      return { output: parsed.data, usage };
    },
  };
}
