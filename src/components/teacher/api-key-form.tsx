"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { removeApiKeyAction, saveApiKeyAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Spinner } from "@/components/ui/spinner";
import { SubmitButton } from "@/components/ui/submit-button";
import { isKeySavedMessage, keySavedMessage, removeKeyQuestion } from "@/lib/api-key-messages";
import type { ActionResult, TeacherSettingsView, WorkerStatus } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface ApiKeyFormProps {
  apiKey: TeacherSettingsView["apiKey"];
  aiMode: "claude" | "fake";
  model: string;
  keyIssue: WorkerStatus["keyIssue"];
}

/**
 * The app's Anthropic API key: which key grading uses, and a form to save a new one. The key is only ever
 * typed here: the input is uncontrolled, so React clears it after each submit, and nothing sends it back.
 */
export function ApiKeyForm({ apiKey, aiMode, model, keyIssue }: ApiKeyFormProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(saveApiKeyAction, null);
  const remove = useActionRunner();
  // Which of the two actions answered last, so only its outcome shows.
  const [removed, setRemoved] = useState(false);
  const saveResult = removed ? null : state;
  const fieldError = saveResult && !saveResult.ok ? saveResult.fieldErrors?.apiKey : undefined;
  // Also for a field error (a rejected key): the alert is announced, while the list under the field is not.
  const formError = saveResult && !saveResult.ok ? saveResult.error : null;
  const notice = removed ? "Saved key removed." : saveResult?.ok ? (saveResult.message ?? keySavedMessage(aiMode)) : null;
  const warning = !removed && notice !== null && !isKeySavedMessage(notice);
  // React clears the uncontrolled input after each save; a rejected key puts the focus back in it.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (fieldError) inputRef.current?.focus();
  }, [fieldError]);

  function removeKey() {
    if (!window.confirm(removeKeyQuestion({ aiMode, envKeySet: apiKey.envKeySet, unreadable: apiKey.unreadable }))) return;
    remove.run(removeApiKeyAction, () => setRemoved(true));
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        The grader uses this key to send papers to Claude. It&apos;s stored encrypted on this server and is never shown
        again in full. Create one in the Anthropic Console under API keys.
      </p>

      <KeyStatus apiKey={apiKey} aiMode={aiMode} model={model} keyIssue={keyIssue} />

      <form action={formAction} onSubmit={() => setRemoved(false)} className="flex flex-col gap-3">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field
          label="New API key"
          htmlFor="api-key"
          hint="Paste the whole key. It's checked with Anthropic before it's saved."
          error={fieldError}
        >
          <Input
            ref={inputRef}
            id="api-key"
            type="password"
            name="apiKey"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingText="Checking…">Save key</SubmitButton>
          {/* A key that can't be read any more can be removed too, e.g. to keep grading with ANTHROPIC_API_KEY. */}
          {(apiKey.source === "app" || apiKey.unreadable) && (
            <Button variant="secondary" disabled={remove.pending} onClick={removeKey}>
              {remove.pending && <Spinner className="size-4" />}
              Remove saved key
            </Button>
          )}
        </div>
      </form>

      <p role="status" className={cx("text-sm empty:hidden", warning ? "text-warning-800" : "text-success-800")}>
        {notice}
      </p>
      {remove.error && <Alert tone="danger">{remove.error}</Alert>}
      <p className="text-xs text-muted">
        Model: <span className="font-mono">{model}</span>
      </p>
    </div>
  );
}

/** Which key grading uses right now; the first problem found wins. */
function KeyStatus({ apiKey, aiMode, model, keyIssue }: ApiKeyFormProps) {
  if (aiMode === "fake") {
    return (
      <>
        <Alert tone="info" title="Practice mode">
          This server runs the practice grader (AI_MODE=fake), so no key is used. A key saved here is used once AI_MODE=claude.
        </Alert>
        {/* Still shown, so a teacher can tell which key is saved (and remove it) before switching to AI_MODE=claude. */}
        {apiKey.source === "app" && <SavedKey apiKey={apiKey} model={model} />}
        {apiKey.unreadable && (
          <p className="text-sm">
            A key was saved here, but this server&apos;s secret changed since, so it can&apos;t be read. Enter it again or remove it.
          </p>
        )}
      </>
    );
  }
  if (apiKey.unreadable) {
    return (
      <>
        <Alert tone="danger" title="The saved key can't be read">
          This server&apos;s secret changed since the key was saved, so it can&apos;t be decrypted. Enter the key again, or
          remove it.
        </Alert>
        <p className="text-sm">
          {apiKey.source === "env"
            ? "In use meanwhile: the server's ANTHROPIC_API_KEY setting, until you enter the key again or remove the saved one."
            : "Papers wait in the queue until you add a key."}
        </p>
      </>
    );
  }
  if (keyIssue === "rejected") {
    return (
      <Alert tone="danger" title="Anthropic rejected the key in use">
        Grading is paused until you replace it.
      </Alert>
    );
  }
  switch (apiKey.source) {
    case "app":
      return <SavedKey apiKey={apiKey} model={model} />;
    case "env":
      return <p className="text-sm">In use: the server&apos;s ANTHROPIC_API_KEY setting. A key saved here takes its place.</p>;
    case "none":
      return (
        <Alert tone="warning" title="No API key yet">
          Papers wait in the queue until you add one.
        </Alert>
      );
  }
}

/**
 * The key saved on this page: masked, who saved it and when, and whether it is confirmed to work: a key Anthropic
 * couldn't check, or that couldn't use the model, when it was saved is confirmed by the first AI call that succeeds.
 */
function SavedKey({ apiKey, model }: { apiKey: ApiKeyFormProps["apiKey"]; model: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="break-words">
          In use: the key saved here — <span className="font-mono">{apiKey.masked}</span>
        </span>
        {apiKey.check === "unverified" && <Badge tone="warning">Not confirmed yet</Badge>}
      </p>
      {apiKey.check === "unverified" && (
        <p className="text-muted">
          When it was saved, Anthropic couldn&apos;t confirm that this key can use <span className="font-mono">{model}</span>. This
          clears once a paper is graded with it.
        </p>
      )}
      {apiKey.setAt !== null && (
        <p className="text-muted">
          Saved by {apiKey.setByName ?? "a teacher"} on <LocalTime ms={apiKey.setAt} />.
        </p>
      )}
    </div>
  );
}
