"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { aiModelSavedMessage } from "@/lib/ai-models";
import { keySavedMessage } from "@/lib/api-key-messages";
import { requireTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { engineSavedMessage, HOSTED_AGENT_READY } from "@/lib/grader-engine-messages";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { checkApiKeySave } from "@/lib/http/rate-limit";
import { formFields, parseInput } from "@/lib/http/validation";
import {
  removeApiKey, saveApiKey, saveGradingPreferences, setAiModel, setGradingEngine, setStudentUploads, setUpHostedAgentAgain,
} from "@/lib/services/settings";
import { AI_MODELS, type ActionResult, type AiModel, type GradingEngineChoice } from "@/lib/types";

// Shape only: saveApiKey checks the key's format, and saveGradingPreferences the preferences' length.
const ApiKeyFormSchema = z.object({
  apiKey: z
    .string("Paste your API key.")
    .max(400, "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."),
});
const PreferencesFormSchema = z.object({
  gradingPreferences: z.string().max(8000, "Use at most 4000 characters."),
});
const EnabledSchema = z.boolean();
const EngineSchema = z.enum(["agent", "direct"]);
const AiModelSchema = z.enum(AI_MODELS, "Choose Claude Sonnet 5.5 or Claude Opus 5.5.");

/** Checks the pasted key with Anthropic before saving it; the key itself never comes back to the browser. */
export async function saveApiKeyAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const teacher = await requireTeacher();
  const result = await attemptWithData(() => {
    checkApiKeySave(teacher.id);
    const { apiKey } = parseInput(ApiKeyFormSchema, formFields(fd, ["apiKey"]));
    return saveApiKey(teacher, apiKey);
  });
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: result.data.warning ?? keySavedMessage(getConfig().aiMode) };
}

export async function removeApiKeyAction(): Promise<ActionResult> {
  await requireTeacher();
  const result = await attempt(() => removeApiKey());
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Saved key removed." };
}

export async function setStudentUploadsAction(enabled: boolean): Promise<ActionResult> {
  await requireTeacher();
  const result = await attempt(() => setStudentUploads(parseInput(EnabledSchema, enabled)));
  if (result.ok) refresh();
  return result;
}

/** Settings → Grader: switches the grading engine from the next paper on. */
export async function setGradingEngineAction(engine: GradingEngineChoice): Promise<ActionResult> {
  await requireTeacher();
  const result = await attempt(() => setGradingEngine(parseInput(EngineSchema, engine)));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: engineSavedMessage(engine) };
}

/** Settings → AI model: the model that reads answer keys and grades papers from the next one on. */
export async function setAiModelAction(model: AiModel): Promise<ActionResult> {
  await requireTeacher();
  const result = await attemptWithData(() => {
    const chosen = parseInput(AiModelSchema, model);
    setAiModel(chosen);
    return chosen;
  });
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: aiModelSavedMessage(result.data) };
}

/** "Set up now" / "Set up again": sets up the hosted agent for the key in use, waiting at most a minute. */
export async function setUpHostedAgentAction(): Promise<ActionResult> {
  await requireTeacher();
  const result = await attemptWithData(() => setUpHostedAgentAgain());
  if (!result.ok) return result;
  refresh();
  return result.data.ok ? { ok: true, message: HOSTED_AGENT_READY } : { ok: false, error: result.data.error };
}

export async function saveGradingPreferencesAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const teacher = await requireTeacher();
  const result = await attempt(() =>
    saveGradingPreferences(teacher, parseInput(PreferencesFormSchema, formFields(fd, ["gradingPreferences"])).gradingPreferences));
  if (!result.ok) return result;
  refresh();
  return {
    ok: true,
    message:
      "Saved. Papers graded from now on follow them. To apply them to papers already graded, use “Regrade … with your latest corrections” on each assignment.",
  };
}
