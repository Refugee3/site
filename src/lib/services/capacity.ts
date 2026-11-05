import "server-only";
import * as z from "zod";
import { resetGrader, resolveApiKeyPresent } from "@/lib/ai";
import { testOllamaConnection } from "@/lib/ai/ollama/connection";
import { now } from "@/lib/clock";
import {
  getOllamaExtraUrls, getOverflowSettings, getOverflowSpend, monthKey, type OverflowSettings, setOllamaExtraUrls, setOverflowSettings,
} from "@/lib/db/repos/capacity";
import { getOllamaSettings } from "@/lib/db/repos/settings";
import { AppError } from "@/lib/errors";
import { parseInput } from "@/lib/http/validation";
import { resumeWorker } from "@/lib/jobs/queue";
import { OllamaBaseUrlSchema } from "@/lib/ollama-settings";

// Settings → "More grading capacity": other computers running Ollama, and the Claude overflow.

/** At most this many other computers. */
export const MAX_OTHER_COMPUTERS = 8;

/** Addresses typed one per line (or separated by commas or spaces) → validated, without duplicates or this computer's. */
export function parseOtherComputers(text: string, primary: string): string[] {
  const parts = text.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  const urls: string[] = [];
  for (const part of parts) {
    const otherScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(part) && !/^https?:\/\//i.test(part);
    const withScheme = /^https?:\/\//i.test(part) ? part : `http://${part}`;
    const parsed = OllamaBaseUrlSchema.safeParse(withScheme);
    if (otherScheme || !parsed.success) {
      throw new AppError("validation", "Some fields need fixing.", {
        fieldErrors: { otherComputers: [`"${part}" isn't an address. Use one per line, like http://192.168.1.31:11434.`] },
      });
    }
    const withPort = new URL(parsed.data).port === "" && !/^https:/i.test(parsed.data) ? parsed.data.replace(/^(http:\/\/[^/]+)/i, "$1:11434") : parsed.data;
    if (withPort !== primary && !urls.includes(withPort)) urls.push(withPort);
  }
  if (urls.length > MAX_OTHER_COMPUTERS) {
    throw new AppError("validation", "Some fields need fixing.", { fieldErrors: { otherComputers: [`Add at most ${MAX_OTHER_COMPUTERS} computers.`] } });
  }
  return urls;
}

export function saveOtherComputers(input: { otherComputers?: unknown }): string[] {
  const text = typeof input.otherComputers === "string" ? input.otherComputers : "";
  const urls = parseOtherComputers(text, getOllamaSettings().baseUrl);
  setOllamaExtraUrls(urls);
  resetGrader();
  resumeWorker();
  return urls;
}

export interface ComputerCheck {
  url: string;
  ok: boolean;
  /** "Ready", or what's wrong and how to fix it. */
  text: string;
}

/** Tests each address typed (saved or not) with the model saved for this computer. */
export async function testOtherComputers(input: { otherComputers?: unknown }, test = testOllamaConnection): Promise<ComputerCheck[]> {
  const { baseUrl, model } = getOllamaSettings();
  const urls = parseOtherComputers(typeof input.otherComputers === "string" ? input.otherComputers : "", baseUrl);
  return Promise.all(urls.map(async (url): Promise<ComputerCheck> => {
    const result = await test({ baseUrl: url, model });
    if (!result.ok) return { url, ok: false, text: `${result.error} ${result.fix}` };
    if (result.fix) return { url, ok: false, text: `Reachable, but: ${result.fix}` };
    return { url, ok: true, text: `Ready: ${model} is downloaded there.` };
  }));
}

const OverflowSchema = z.object({
  enabled: z.enum(["on", "off"]).default("off"),
  afterPapers: z.coerce.number("Enter a number of papers.").int("Enter a whole number.").min(1, "Enter 1 or more.").max(10000, "Enter at most 10000."),
  monthlyCapUsd: z.coerce.number("Enter a dollar amount.").int("Enter whole dollars.").min(1, "Enter at least $1.").max(100000, "Enter at most $100000."),
});

export function saveOverflowSettings(input: unknown): OverflowSettings {
  const s = parseInput(OverflowSchema, input);
  const settings = { enabled: s.enabled === "on", afterPapers: s.afterPapers, monthlyCapUsd: s.monthlyCapUsd };
  if (settings.enabled && !resolveApiKeyPresent()) {
    throw new AppError("invalid_state", "Add an Anthropic API key first (top of this page): the overflow grades with Claude.");
  }
  setOverflowSettings(settings);
  resetGrader();
  return settings;
}

export interface CapacityView {
  primaryUrl: string;
  otherComputers: string[];
  overflow: OverflowSettings;
  /** This month's overflow spend. */
  spentUsd: number;
  spentPapers: number;
  hasApiKey: boolean;
}

export function getCapacityView(): CapacityView {
  const spend = getOverflowSpend(monthKey(now()));
  return {
    primaryUrl: getOllamaSettings().baseUrl,
    otherComputers: getOllamaExtraUrls(),
    overflow: getOverflowSettings(),
    spentUsd: spend.microUsd / 1_000_000,
    spentPapers: spend.papers,
    hasApiKey: resolveApiKeyPresent(),
  };
}
