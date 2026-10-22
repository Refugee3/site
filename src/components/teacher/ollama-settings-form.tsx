"use client";

import { useActionState, useState } from "react";
import { saveOllamaSettingsAction, testOllamaConnectionAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  DEFAULT_OLLAMA_MODEL, imageEdgeHint, MAX_OLLAMA_IMAGE_MAX_EDGE, MAX_OLLAMA_NUM_CTX, MAX_PAPERS_AT_A_TIME, MIN_OLLAMA_IMAGE_MAX_EDGE,
  MIN_OLLAMA_NUM_CTX, MIN_PAPERS_AT_A_TIME, ollamaImageEdge, type OllamaConnectionResult, type OllamaModelInfo, type OllamaSettings,
  PAPERS_AT_A_TIME_HINT, pullCommand, RECOMMENDED_OLLAMA_MODELS,
} from "@/lib/ollama-settings";
import type { ActionResult, OllamaSpeedView } from "@/lib/types";
import { recentLocalTimeText } from "./grading-time";
import { useActionRunner } from "./use-action-runner";

export interface OllamaSettingsFormProps {
  settings: OllamaSettings;
  /** What the server found at the saved address when the page loaded (null when it didn't look). */
  initialCheck: OllamaConnectionResult | null;
  /** Page image size and papers at a time, and how long recent papers took. */
  speed: OllamaSpeedView;
}

const PAPERS_CHOICES = Array.from({ length: MAX_PAPERS_AT_A_TIME - MIN_PAPERS_AT_A_TIME + 1 }, (_, i) => MIN_PAPERS_AT_A_TIME + i);

const OTHER = "__other__";

/**
 * Settings → Grader → On this computer (Ollama): where Ollama listens, which downloaded model grades (vision models first), the
 * context size, the page image size and papers at a time (speed), and "Test connection", which checks the address typed here
 * before it is saved.
 */
export function OllamaSettingsForm({ settings, initialCheck, speed }: OllamaSettingsFormProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(saveOllamaSettingsAction, null);
  const tester = useActionRunner();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [check, setCheck] = useState<OllamaConnectionResult | null>(initialCheck);
  const models = check?.ok ? check.models : [];
  const listed = models.some((m) => m.name === model);
  const [typing, setTyping] = useState(false);
  // A model Ollama didn't list (not downloaded yet, or typed) is shown in the text field.
  const choosing = listed && !typing;
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  function test() {
    tester.run(() => testOllamaConnectionAction({ baseUrl, model }), (result) => {
      setCheck(result.data ?? null);
    });
  }

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-lg border border-line-strong p-4">
      <p className="text-sm text-muted">
        Install Ollama from ollama.com, then download a vision model once, for example{" "}
        <code className="font-mono">{pullCommand(DEFAULT_OLLAMA_MODEL)}</code>. Papers are read on this computer: nothing is sent
        to Anthropic and no API key is needed.
      </p>
      {state && !state.ok && !fieldErrors && <Alert tone="danger">{state.error}</Alert>}

      <Field label="Ollama address" htmlFor="ollama-base-url" hint="Usually http://localhost:11434." error={fieldErrors?.baseUrl}>
        <Input
          id="ollama-base-url"
          name="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Field label="Model" htmlFor={choosing ? "ollama-model-choice" : "ollama-model"} hint={modelHint(models)} error={fieldErrors?.model}>
        {choosing ? (
          <Select
            id="ollama-model-choice"
            value={model}
            onChange={(e) => {
              if (e.target.value === OTHER) setTyping(true);
              else setModel(e.target.value);
            }}
          >
            {models.map((m) => (
              <option key={m.name} value={m.name}>{modelLabel(m)}</option>
            ))}
            <option value={OTHER}>Type another name…</option>
          </Select>
        ) : (
          <Input
            id="ollama-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list="ollama-recommended-models"
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <input type="hidden" name="model" value={model} />
      <datalist id="ollama-recommended-models">
        {RECOMMENDED_OLLAMA_MODELS.map((m) => (
          <option key={m.name} value={m.name}>{m.note}</option>
        ))}
      </datalist>
      {models.length > 0 && !choosing && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setModel(models[0].name);
              setTyping(false);
            }}
          >
            Choose from the downloaded models
          </Button>
        </div>
      )}

      <Field
        label="Context size (tokens)"
        htmlFor="ollama-num-ctx"
        hint={`How much the model reads at once: the instructions, the key and the page images. 16384 suits most worksheets; raise it `
          + `if long papers fail, at the cost of more memory (${MIN_OLLAMA_NUM_CTX}–${MAX_OLLAMA_NUM_CTX}).`}
        error={fieldErrors?.numCtx}
      >
        <Input
          id="ollama-num-ctx"
          name="numCtx"
          type="number"
          inputMode="numeric"
          min={MIN_OLLAMA_NUM_CTX}
          max={MAX_OLLAMA_NUM_CTX}
          step={1024}
          defaultValue={settings.numCtx}
          className="max-w-40"
        />
      </Field>

      <Field label="Page image size (pixels)" htmlFor="ollama-image-edge" hint={imageEdgeHint(model, speed.envImageMaxEdge)}
        error={fieldErrors?.imageMaxEdge}>
        <Input
          id="ollama-image-edge"
          name="imageMaxEdge"
          type="number"
          inputMode="numeric"
          min={MIN_OLLAMA_IMAGE_MAX_EDGE}
          max={MAX_OLLAMA_IMAGE_MAX_EDGE}
          step={64}
          defaultValue={speed.imageMaxEdge ?? ""}
          placeholder={`Automatic (${ollamaImageEdge(model, { setting: null, env: speed.envImageMaxEdge })})`}
          className="max-w-48"
        />
      </Field>

      <Field label="Papers at a time" htmlFor="ollama-papers-at-a-time" hint={PAPERS_AT_A_TIME_HINT} error={fieldErrors?.papersAtATime}>
        <Select
          id="ollama-papers-at-a-time"
          name="papersAtATime"
          defaultValue={String(speed.papersAtATime ?? Math.min(MAX_PAPERS_AT_A_TIME, Math.max(MIN_PAPERS_AT_A_TIME, speed.envConcurrency)))}
          className="max-w-40"
        >
          {PAPERS_CHOICES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </Select>
      </Field>

      {speed.recent && <p className="text-sm text-muted">{recentLocalTimeText(speed.recent)}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
        <Button variant="secondary" disabled={tester.pending} aria-busy={tester.pending || undefined} onClick={test}>
          {tester.pending && <Spinner className="size-4" />}
          {tester.pending ? "Testing…" : "Test connection"}
        </Button>
      </div>
      <p role="status" className="text-sm text-success-800 empty:hidden">
        {state?.ok ? state.message : null}
      </p>
      {tester.error && <Alert tone="danger">{tester.error}</Alert>}
      {check && <ConnectionStatus check={check} />}
    </form>
  );
}

function ConnectionStatus({ check }: { check: OllamaConnectionResult }) {
  if (!check.ok) {
    return (
      <Alert tone="danger" title="Ollama can't be reached">
        <p>{check.error}</p>
        <p className="mt-1">{check.fix}</p>
      </Alert>
    );
  }
  const vision = check.models.filter((m) => m.vision !== false).length;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        Ollama: <Badge tone="success">Reachable</Badge>
        {check.version && <span className="text-muted">version {check.version}</span>}
        <span className="text-muted">
          · {check.models.length === 1 ? "1 model" : `${check.models.length} models`} downloaded
          {check.models.length > 0 && `, ${vision} that can read images`}
        </span>
      </p>
      {check.fix && (
        <Alert tone="warning">
          <span className="font-mono break-words">{check.fix}</span>
        </Alert>
      )}
    </div>
  );
}

function modelLabel(m: OllamaModelInfo): string {
  const size = m.size === null ? "" : ` · ${(m.size / 1e9).toFixed(1)} GB`;
  const reads = m.vision === true ? " · reads images" : m.vision === false ? " · text only (can't read pages)" : "";
  return `${m.name}${reads}${size}`;
}

function modelHint(models: OllamaModelInfo[]): string {
  const suggestions = RECOMMENDED_OLLAMA_MODELS.map((m) => `${m.name} (${m.note})`).join("; ");
  return models.length > 0
    ? `Models that can read page images come first. Suggested: ${suggestions}.`
    : `A vision model downloaded in Ollama. Suggested: ${suggestions}. Test the connection to choose from your downloaded models.`;
}
