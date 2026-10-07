"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { saveGradingPreferencesAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/types";
import { useLeaveGuard } from "./use-leave-guard";
import { useSyncedState } from "./use-synced-state";

const MAX_PREFERENCES = 4000;

const PLACEHOLDER =
  "e.g. Ignore spelling mistakes unless the question is about spelling.\nGive full credit when the method is right but there's a small arithmetic slip.";

/** The teacher's standing notes for the grader, read with every paper in all of their assignments. */
export function PreferencesForm({ preferences }: { preferences: string }) {
  const [state, dispatch, pending] = useActionState<ActionResult | null, FormData>(saveGradingPreferencesAction, null);
  // Controlled (for the counter) and submitted without React's form reset, so a rejected save keeps the text.
  const [text, setText, expectSaved] = useSyncedState(preferences);
  const dirty = text !== preferences;
  const fieldError = state && !state.ok ? state.fieldErrors?.gradingPreferences : undefined;
  // Also for a field error: the alert is announced, while the list under the field is not.
  const formError = state && !state.ok ? state.error : null;
  // "Saved" shows until the next edit.
  const savedMessage = state?.ok && !dirty ? state.message : null;

  useLeaveGuard(dirty, "Your grading preferences are not saved. Leave and lose them?");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    // The saved preferences come back trimmed; show them, not the typed text.
    expectSaved();
    startTransition(() => dispatch(fd));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        The grader reads these with every paper you grade, in all of your assignments. Write them like notes to a
        teaching assistant.
      </p>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <Field
        label="Your grading preferences"
        htmlFor="grading-preferences"
        hint={`${text.length} / ${MAX_PREFERENCES}`}
        error={fieldError}
      >
        <Textarea
          id="grading-preferences"
          name="gradingPreferences"
          rows={6}
          maxLength={MAX_PREFERENCES}
          placeholder={PLACEHOLDER}
          readOnly={pending}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!dirty || pending} aria-busy={pending || undefined}>
          {pending && <Spinner className="size-4" />}
          Save preferences
        </Button>
        <p role="status" className="text-sm text-success-800">
          {savedMessage}
        </p>
      </div>
      <p className="text-sm text-muted">
        Corrections you make on single papers are kept as lessons on each assignment&apos;s Lessons tab.
      </p>
    </form>
  );
}
