"use client";

import { useActionState, useState } from "react";
import { saveOtherComputersAction, saveOverflowSettingsAction, testOtherComputersAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface CapacitySettingsProps {
  view: {
    primaryUrl: string;
    otherComputers: string[];
    overflow: { enabled: boolean; afterPapers: number; monthlyCapUsd: number };
    spentUsd: number;
    spentPapers: number;
    hasApiKey: boolean;
  };
  /** Ollama is the chosen grader (both settings only apply then). */
  ollamaChosen: boolean;
}

type Check = { url: string; ok: boolean; text: string };

/**
 * Settings → "More grading capacity", for several teachers sharing the grader: other computers running Ollama (papers are
 * spread over them) and the Claude overflow for busy days, with this month's spend.
 */
export function CapacitySettings({ view, ollamaChosen }: CapacitySettingsProps) {
  const [computersState, saveComputers] = useActionState<ActionResult | null, FormData>(saveOtherComputersAction, null);
  const [overflowState, saveOverflow] = useActionState<ActionResult | null, FormData>(saveOverflowSettingsAction, null);
  const tester = useActionRunner();
  const [text, setText] = useState(view.otherComputers.join("\n"));
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [enabled, setEnabled] = useState(view.overflow.enabled);
  const computerErrors = computersState && !computersState.ok ? computersState.fieldErrors : undefined;
  const overflowErrors = overflowState && !overflowState.ok ? overflowState.fieldErrors : undefined;
  const capReached = view.spentUsd >= view.overflow.monthlyCapUsd;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        For several teachers sharing this grader. Papers already take turns between teachers, so one big upload doesn&apos;t hold
        up everyone else.{!ollamaChosen && " These settings apply when the grader is set to On this computer (Ollama)."}
      </p>

      <form action={saveComputers} className="flex flex-col gap-3">
        <h3 className="font-serif text-base font-semibold">Other computers running Ollama</h3>
        <p className="text-sm text-muted">
          Each computer listed grades papers alongside this one ({view.primaryUrl}), so two computers grade about twice as many. On
          each: install Ollama, download the same model, and let other computers reach it (run <code className="font-mono">setx OLLAMA_HOST 0.0.0.0</code>,
          restart Ollama, and allow port 11434 in Windows Firewall). A computer that is off is skipped automatically.
        </p>
        {computersState && !computersState.ok && !computerErrors && <Alert tone="danger">{computersState.error}</Alert>}
        <Field label="Addresses, one per line" htmlFor="other-computers" hint="For example http://192.168.1.31:11434" error={computerErrors?.otherComputers}>
          <Textarea
            id="other-computers"
            name="otherComputers"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="http://192.168.1.31:11434"
            spellCheck={false}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingText="Saving…">Save computers</SubmitButton>
          <Button
            variant="secondary"
            disabled={tester.pending || text.trim() === ""}
            onClick={() => {
              setChecks(null);
              tester.run(() => testOtherComputersAction(text), (r) => setChecks(r.data ?? []));
            }}
          >
            {tester.pending ? "Testing…" : "Test these computers"}
          </Button>
        </div>
        {computersState?.ok && computersState.message && <p role="status" className="text-sm text-success-800">{computersState.message}</p>}
        {tester.error && <Alert tone="danger">{tester.error}</Alert>}
        {checks && (
          <ul className="flex flex-col gap-1 text-sm">
            {checks.map((c) => (
              <li key={c.url} className={c.ok ? "text-success-800" : "text-danger-700"}>
                <span className="font-mono">{c.url}</span>: {c.text}
              </li>
            ))}
          </ul>
        )}
      </form>

      <form action={saveOverflow} className="flex flex-col gap-3 border-t border-line pt-5">
        <h3 className="font-serif text-base font-semibold">Claude overflow for busy days</h3>
        <p className="text-sm text-muted">
          Normally every paper is graded free on your computers. When they&apos;re all busy and many papers are waiting (everyone
          uploading after a quiz), extra papers go to Claude with the API key above, so nobody waits long. It stops for the month at
          your cap.
        </p>
        {!view.hasApiKey && <Alert tone="info">Add an Anthropic API key at the top of this page to use the overflow.</Alert>}
        {overflowState && !overflowState.ok && !overflowErrors && <Alert tone="danger">{overflowState.error}</Alert>}
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="enabled"
            className="mt-1 size-4 accent-brand-600"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span className="font-medium">Send extra papers to Claude when the line is long</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When more than this many papers are waiting" htmlFor="overflow-after" error={overflowErrors?.afterPapers}>
            <Input id="overflow-after" name="afterPapers" type="number" inputMode="numeric" min={1} max={10000} defaultValue={view.overflow.afterPapers} />
          </Field>
          <Field label="Spend at most, per month (US dollars)" htmlFor="overflow-cap" error={overflowErrors?.monthlyCapUsd}>
            <Input id="overflow-cap" name="monthlyCapUsd" type="number" inputMode="numeric" min={1} max={100000} defaultValue={view.overflow.monthlyCapUsd} />
          </Field>
        </div>
        <p className={capReached ? "text-sm font-semibold text-warning-800" : "text-sm text-muted"}>
          This month: about ${view.spentUsd.toFixed(2)} on {view.spentPapers} {view.spentPapers === 1 ? "paper" : "papers"} sent to Claude
          {capReached ? " — the cap is reached; papers are graded on your computers until next month." : "."}
        </p>
        <div>
          <SubmitButton pendingText="Saving…">Save overflow</SubmitButton>
        </div>
        {overflowState?.ok && overflowState.message && <p role="status" className="text-sm text-success-800">{overflowState.message}</p>}
      </form>
    </div>
  );
}
