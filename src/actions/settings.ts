"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { keySavedMessage } from "@/lib/api-key-messages";
import { requireTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { checkApiKeySave } from "@/lib/http/rate-limit";
import { formFields, parseInput } from "@/lib/http/validation";
import { removeApiKey, saveApiKey, saveGradingPreferences, setStudentUploads } from "@/lib/services/settings";
import type { ActionResult } from "@/lib/types";

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
