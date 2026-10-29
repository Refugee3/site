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
import type { OllamaConnectionResult } from "@/lib/ollama-settings";
import { type ComputerCheck, saveOtherComputers, saveOverflowSettings, testOtherComputers } from "@/lib/services/capacity";
import { removeEmailSettings, saveEmailSettings, sendTestEmail, setTeacherEmailNotifications } from "@/lib/services/email";
import {
  checkOllamaConnection, removeApiKey, saveApiKey, saveGradingPreferences, saveOllamaSettings, setAiModel, setGradingEngine,
  setUpHostedAgentAgain,
} from "@/lib/services/settings";
import { AI_MODELS, type ActionResult, GRADING_ENGINE_CHOICES, type AiModel, type GradingEngineChoice } from "@/lib/types";

// Shape only: saveApiKey checks the key's format, and saveGradingPreferences the preferences' length.
const ApiKeyFormSchema = z.object({
  apiKey: z
    .string("Paste your API key.")
    .max(400, "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."),
});
const PreferencesFormSchema = z.object({
  gradingPreferences: z.string().max(8000, "Use at most 4000 characters."),
});
const EngineSchema = z.enum(GRADING_ENGINE_CHOICES, "Choose one of the graders.");
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

/**
 * Settings → Grader → On this computer (Ollama): saves the address, model and context size, the page image size and the
 * papers at a time (fields baseUrl, model, numCtx, imageMaxEdge, papersAtATime).
 */
export async function saveOllamaSettingsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  await requireTeacher();
  const result = await attemptWithData(() => saveOllamaSettings(formFields(fd, ["baseUrl", "model", "numCtx", "imageMaxEdge", "papersAtATime"])));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: `Saved. Papers graded from now on use ${result.data.model} on this computer.` };
}

/** "Test connection": whether Ollama answers at the typed address, and which models it has. Nothing is saved. */
export async function testOllamaConnectionAction(
  input: { baseUrl: string; model: string },
): Promise<ActionResult<OllamaConnectionResult>> {
  await requireTeacher();
  const result = await attemptWithData(() => checkOllamaConnection(input));
  // A field's own message ("Enter the address Ollama listens on…") says more than "Some fields need fixing."
  if (!result.ok) return { ok: false, error: Object.values(result.fieldErrors ?? {})[0]?.[0] ?? result.error };
  return { ok: true, data: result.data };
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

/** Settings → Email: the outgoing mail account (fields host, port, security, user, password, from, publicUrl). */
export async function saveEmailSettingsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  await requireTeacher();
  const result = await attempt(() => saveEmailSettings(formFields(fd, ["host", "port", "security", "user", "password", "from", "publicUrl"])));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Saved. Send a test email to check it works." };
}

export async function removeEmailSettingsAction(): Promise<ActionResult> {
  await requireTeacher();
  const result = await attempt(() => removeEmailSettings());
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Email turned off: no emails are sent." };
}

/** "Send a test email": to the signed-in teacher's own address, with the saved account. */
export async function sendTestEmailAction(): Promise<ActionResult> {
  const teacher = await requireTeacher();
  const result = await attempt(() => sendTestEmail(teacher));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: `Sent to ${teacher.email}. If it isn't in your inbox in a minute, look in spam.` };
}

/** The signed-in teacher's "Email me when grading is done". */
export async function setEmailNotificationsAction(on: boolean): Promise<ActionResult> {
  const teacher = await requireTeacher();
  const result = await attempt(() => setTeacherEmailNotifications(teacher, on === true));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: on ? "You'll get an email when grading is done." : "Emails turned off for you." };
}

/** Settings → More grading capacity: the other computers running Ollama (field otherComputers, one address per line). */
export async function saveOtherComputersAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  await requireTeacher();
  const result = await attemptWithData(() => saveOtherComputers(formFields(fd, ["otherComputers"])));
  if (!result.ok) return result;
  refresh();
  const n = result.data.length;
  return { ok: true, message: n === 0 ? "Saved. Only this computer grades." : `Saved. Papers are spread over this computer and ${n} other${n === 1 ? "" : "s"}.` };
}

/** "Test these computers": whether each address typed answers and has the model. Nothing is saved. */
export async function testOtherComputersAction(otherComputers: string): Promise<ActionResult<ComputerCheck[]>> {
  await requireTeacher();
  const result = await attemptWithData(() => testOtherComputers({ otherComputers }));
  if (!result.ok) return { ok: false, error: Object.values(result.fieldErrors ?? {})[0]?.[0] ?? result.error };
  return { ok: true, data: result.data };
}

/** Settings → More grading capacity: the Claude overflow (fields enabled, afterPapers, monthlyCapUsd). */
export async function saveOverflowSettingsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  await requireTeacher();
  const result = await attemptWithData(() => saveOverflowSettings(formFields(fd, ["enabled", "afterPapers", "monthlyCapUsd"])));
  if (!result.ok) return result;
  refresh();
  const s = result.data;
  return {
    ok: true,
    message: s.enabled
      ? `Saved. When more than ${s.afterPapers} papers wait, extra ones go to Claude, up to $${s.monthlyCapUsd} a month.`
      : "Saved. The overflow is off: everything is graded on your computers.",
  };
}
