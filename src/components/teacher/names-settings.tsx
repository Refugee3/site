"use client";

import { useActionState, useState } from "react";
import { removeNamesKeyAction, saveNamesSettingsAction, testChatGptAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface NamesSettingsProps {
  view: { enabled: boolean; keyMasked: string | null; baseUrl: string; model: string; missingKey: boolean };
}

/**
 * Settings → "Student names": when on, ChatGPT (the school's account) is the only AI that sees student names. Before a paper
 * is graded it reads the name and finds every name, ID, email and signature; DragonGrader covers them with the paper's
 * anonymous ID, ChatGPT checks the copy, and only that copy goes to the grading AI (Ollama or Claude).
 */
export function NamesSettings({ view }: NamesSettingsProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(saveNamesSettingsAction, null);
  const tester = useActionRunner();
  const remover = useActionRunner();
  const [message, setMessage] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(view.enabled);
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        With this on, the grading AI never sees a student&apos;s name. Before each paper is graded, ChatGPT reads the name and
        finds every place a name, student ID, email or signature is written. DragonGrader covers them with the paper&apos;s
        random ID (like <span className="font-mono">S-482913</span>), ChatGPT checks the covered copy, and only that copy is
        graded. The results show the name next to the ID. Class scans are split by ChatGPT too.
      </p>

      {view.missingKey && (
        <Alert tone="warning" title="Papers are waiting">
          Name hiding is on but there is no working ChatGPT key, so nothing is graded. Enter the key below.
        </Alert>
      )}

      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="enabled"
            className="mt-1 size-4 accent-brand-600"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            <span className="font-medium">Hide student names with ChatGPT before grading</span>
            <span className="block text-sm text-muted">Required if only ChatGPT may process student names.</span>
          </span>
        </label>

        <Field
          label="ChatGPT API key"
          htmlFor="names-api-key"
          hint={view.keyMasked ? `Saved: ${view.keyMasked}. Leave empty to keep it.` : "From your school's ChatGPT (OpenAI) account; ask IT for an API key."}
          error={fieldErrors?.apiKey}
        >
          <Input id="names-api-key" name="apiKey" type="password" autoComplete="off" placeholder={view.keyMasked ?? "sk-…"} />
        </Field>
        <Field
          label="API address"
          htmlFor="names-base-url"
          hint="Leave as is for OpenAI. Use the address IT gives you if your school's ChatGPT has its own."
          error={fieldErrors?.baseUrl}
        >
          <Input id="names-base-url" name="baseUrl" defaultValue={view.baseUrl} />
        </Field>
        <Field label="Model" htmlFor="names-model" hint="The model name your school's account offers." error={fieldErrors?.model}>
          <Input id="names-model" name="model" defaultValue={view.model} className="sm:max-w-60" />
        </Field>

        {state && !state.ok && <Alert tone="danger">{state.error}</Alert>}
        {state?.ok && state.message && <Alert tone="success">{state.message}</Alert>}

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton>Save</SubmitButton>
          <Button
            variant="secondary"
            disabled={tester.pending || !view.keyMasked}
            onClick={() => {
              setMessage(null);
              tester.run(testChatGptAction, (r) => setMessage(r.message ?? "ChatGPT answered."));
            }}
          >
            Test
          </Button>
          {view.keyMasked && (
            <Button
              variant="ghost"
              disabled={remover.pending}
              onClick={() => {
                if (window.confirm("Remove the ChatGPT key? Name hiding turns off.")) remover.run(removeNamesKeyAction);
              }}
            >
              Remove key
            </Button>
          )}
        </div>
        {message && <p role="status" className="text-sm text-success-800">{message}</p>}
        {(tester.error || remover.error) && <Alert tone="danger">{tester.error ?? remover.error}</Alert>}
      </form>
    </div>
  );
}
