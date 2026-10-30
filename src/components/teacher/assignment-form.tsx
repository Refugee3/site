"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { KIND_LABEL } from "@/lib/format";
import { ASSIGNMENT_KINDS, type ActionResult, type AssignmentFormInput, type GradingMode, type ProjectMode } from "@/lib/types";
import { KEY_INSTRUCTIONS_PLACEHOLDER } from "./key-instructions-field";
import { useSyncedState } from "./use-synced-state";

export interface AssignmentFormProps {
  mode: "create" | "edit";
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  defaults: AssignmentFormInput;
}

const GRADING_MODE_OPTIONS: Array<{ value: GradingMode; label: string; description: string }> = [
  {
    value: "completion",
    label: "Completion",
    description: "Credit for every question genuinely attempted: full for a complete answer, half for a partial one, right or wrong.",
  },
  {
    value: "accuracy",
    label: "Accuracy",
    description: "Credit for correct answers, with partial credit on items that allow it.",
  },
  {
    value: "blended",
    label: "Blended",
    description: "A mix of completion and accuracy; you choose how much accuracy counts.",
  },
];

/** Notes are most of what the AI writes, and written tokens are the expensive ones (see README → Cost). */
const WRITE_NOTES_HINT = "The AI writes a short note on what each student did and feedback on every question, which you see when "
  + "you check a paper. Turning this on makes each paper cost roughly 1.5 times as much, more for assignments with many questions. "
  + "Off, the grades are the same and you can still write your own notes.";

const PROJECT_MODE_OPTIONS: Array<{ value: ProjectMode; label: string; description: string }> = [
  {
    value: "points",
    label: "Score with points",
    description: "The AI scores each project from your instructions (or the rubric you upload) and explains every score.",
  },
  {
    value: "feedback",
    label: "Feedback only",
    description: "No points. The AI writes what you ask for on each project: an analysis, a summary, or feedback for the student.",
  },
];

const PROJECT_INSTRUCTIONS_PLACEHOLDER = "e.g. Score out of 50: research 20, analysis 20, presentation 10. Or, for feedback only: "
  + "Analyze each section and summarize the main strengths and what to improve.";

const SECTIONS_PLACEHOLDER = "Period 1 | P1, 1st\nPeriod 3 | P3, 3rd";

/** The form as typed: the number field stays text so clearing it does not produce NaN. */
type FormDraft = Omit<AssignmentFormInput, "maxSubmissions" | "projectMode" | "gradingInstructions"> & {
  maxSubmissions: string; projectMode: ProjectMode; gradingInstructions: string;
};

function toDraft(input: AssignmentFormInput): FormDraft {
  return {
    ...input, maxSubmissions: String(input.maxSubmissions), projectMode: input.projectMode ?? "points",
    gradingInstructions: input.gradingInstructions ?? "",
  };
}

const sameDraft = (a: FormDraft, b: FormDraft) => JSON.stringify(a) === JSON.stringify(b);

/** Create and settings form. Field names are the AssignmentFormInput keys the actions parse. */
export function AssignmentForm({ mode, action, defaults }: AssignmentFormProps) {
  const [state, dispatch, pending] = useActionState(action, null);
  // Controlled and submitted without React's automatic form reset, so a rejected save keeps every choice.
  const initial = toDraft(defaults);
  const [values, setValues, expectSaved] = useSyncedState(initial, sameDraft);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  // "Saved" shows until the next edit.
  const savedMessage = mode === "edit" && state?.ok && sameDraft(values, initial) ? (state.message ?? "Settings saved.") : null;

  function update<K extends keyof FormDraft>(key: K, value: FormDraft[K]) {
    setValues({ ...values, [key]: value });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    // The saved settings come back normalized (trimmed title, tidied sections); show them, not the typed text.
    expectSaved();
    startTransition(() => dispatch(fd));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {state && !state.ok && <Alert tone="danger">{state.error}</Alert>}

      <Field label="Title" htmlFor="assignment-title" error={errors.title}>
        <Input
          id="assignment-title"
          name="title"
          required
          maxLength={200}
          value={values.title}
          onChange={(e) => update("title", e.target.value)}
        />
      </Field>

      <fieldset className="flex flex-col gap-2" aria-describedby={errors.kind ? "assignment-kind-error" : undefined}>
        <legend className="mb-1.5 text-sm font-medium text-ink">Type</legend>
        <div className="flex flex-wrap gap-2">
          {ASSIGNMENT_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line-strong bg-surface px-3 has-checked:border-brand-600 has-checked:bg-brand-50"
            >
              <input
                type="radio"
                name="kind"
                value={kind}
                checked={values.kind === kind}
                onChange={() => update("kind", kind)}
                className="size-5 shrink-0 accent-brand-600"
              />
              <span className="font-medium">{KIND_LABEL[kind]}</span>
            </label>
          ))}
        </div>
        {errors.kind && (
          <p id="assignment-kind-error" className="text-sm font-medium text-danger-700">
            {errors.kind.join(" ")}
          </p>
        )}
      </fieldset>

      {values.kind === "project" && (
        <ProjectFields
          mode={mode}
          projectMode={values.projectMode}
          instructions={values.gradingInstructions}
          errors={[...(errors.projectMode ?? []), ...(errors.gradingInstructions ?? [])]}
          onModeChange={(projectMode) => update("projectMode", projectMode)}
          onInstructionsChange={(gradingInstructions) => update("gradingInstructions", gradingInstructions)}
        />
      )}

      <Field
        label="Instructions the students were given (optional)"
        htmlFor="assignment-instructions"
        hint="The AI grader reads these with each paper."
        error={errors.instructions}
      >
        <Textarea
          id="assignment-instructions"
          name="instructions"
          rows={3}
          maxLength={2000}
          value={values.instructions}
          onChange={(e) => update("instructions", e.target.value)}
        />
      </Field>

      {/* Projects are scored by their review; hidden, the choices are kept (and sent) for a change back. */}
      <div hidden={values.kind === "project"} className="flex flex-col gap-5">
      <GradingModeField
        mode={values.gradingMode}
        weight={values.accuracyWeight}
        errors={[...(errors.gradingMode ?? []), ...(errors.accuracyWeight ?? [])]}
        onModeChange={(gradingMode) => update("gradingMode", gradingMode)}
        onWeightChange={(accuracyWeight) => update("accuracyWeight", accuracyWeight)}
      />

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <Input
            type="checkbox"
            name="writeNotes"
            aria-describedby="assignment-write-notes-hint"
            checked={values.writeNotes}
            onChange={(e) => update("writeNotes", e.target.checked)}
          />
          <span className="font-medium">Write feedback notes</span>
        </label>
        <p id="assignment-write-notes-hint" className="text-sm text-muted">
          {WRITE_NOTES_HINT}
        </p>
      </div>
      </div>

      <Field
        label="Class sections (optional)"
        htmlFor="assignment-sections"
        hint={
          <>
            One class period or section per line. After a <code className="font-mono">|</code>, list other ways students
            might write it, separated by commas. Papers are grouped by section. For a single class, enter its one name so
            every paper lands in one group; left empty, papers are grouped by whatever students wrote.
          </>
        }
        error={errors.sectionsText}
      >
        <Textarea
          id="assignment-sections"
          name="sectionsText"
          rows={4}
          placeholder={SECTIONS_PLACEHOLDER}
          className="font-mono"
          value={values.sectionsText}
          onChange={(e) => update("sectionsText", e.target.value)}
        />
      </Field>

      <Field
        label="Maximum number of papers"
        htmlFor="assignment-max"
        hint="Uploads stop once this many papers are in. Re-uploads of a student's paper count too."
        error={errors.maxSubmissions}
      >
        <Input
          id="assignment-max"
          name="maxSubmissions"
          type="number"
          inputMode="numeric"
          min={1}
          max={5000}
          className="sm:max-w-40"
          value={values.maxSubmissions}
          onChange={(e) => update("maxSubmissions", e.target.value)}
        />
      </Field>

      {mode === "edit" && (
        <p className="text-sm text-muted">
          Changing the grading mode or weight rescores every paper right away, and changing sections re-sorts papers
          into them. Neither uses the AI. Turning feedback notes on or off applies to papers graded from then on.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          {pending && <Spinner className="size-4" />}
          {mode === "create" ? `Create ${KIND_LABEL[values.kind].toLowerCase()}` : "Save settings"}
        </Button>
        <p role="status" className="text-sm text-success-800">
          {savedMessage}
        </p>
      </div>
    </form>
  );
}

function ProjectFields(props: {
  mode: "create" | "edit";
  projectMode: ProjectMode;
  instructions: string;
  errors: string[];
  onModeChange: (mode: ProjectMode) => void;
  onInstructionsChange: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">How projects are graded</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PROJECT_MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-lg border border-line-strong bg-surface p-3 has-checked:border-brand-600 has-checked:bg-brand-50"
            >
              <input
                type="radio"
                name="projectMode"
                value={option.value}
                checked={props.projectMode === option.value}
                onChange={() => props.onModeChange(option.value)}
                className="mt-0.5 size-5 shrink-0 accent-brand-600"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-sm text-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {props.mode === "create" && (
        <Field
          label="What should the AI grade or write?"
          htmlFor="assignment-grading-instructions"
          hint="Projects need no answer key: the AI follows these instructions on every project. You can also upload a rubric later."
        >
          <Textarea
            id="assignment-grading-instructions"
            name="gradingInstructions"
            rows={4}
            maxLength={4000}
            placeholder={props.projectMode === "feedback" ? PROJECT_INSTRUCTIONS_PLACEHOLDER : KEY_INSTRUCTIONS_PLACEHOLDER}
            value={props.instructions}
            onChange={(e) => props.onInstructionsChange(e.target.value)}
          />
        </Field>
      )}
      {props.errors.length > 0 && <p className="text-sm font-medium text-danger-700">{props.errors.join(" ")}</p>}
    </div>
  );
}

function GradingModeField(props: {
  mode: GradingMode;
  weight: number;
  errors: string[];
  onModeChange: (mode: GradingMode) => void;
  onWeightChange: (weight: number) => void;
}) {
  const { mode, weight, errors } = props;
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={errors.length > 0 ? "grading-mode-error" : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-ink">How papers are scored</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {GRADING_MODE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer gap-3 rounded-lg border border-line-strong bg-surface p-3 has-checked:border-brand-600 has-checked:bg-brand-50"
          >
            <input
              type="radio"
              name="gradingMode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => props.onModeChange(option.value)}
              className="mt-0.5 size-5 shrink-0 accent-brand-600"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{option.label}</span>
              <span className="text-sm text-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "blended" ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-subtle p-3">
          <label htmlFor="assignment-weight" className="text-sm font-medium">
            Accuracy counts for {weight}% · completion for {100 - weight}%
          </label>
          <input
            id="assignment-weight"
            name="accuracyWeight"
            type="range"
            min={0}
            max={100}
            step={5}
            value={weight}
            aria-valuetext={`${weight}% accuracy, ${100 - weight}% completion`}
            onChange={(e) => props.onWeightChange(e.target.valueAsNumber)}
            className="h-11 w-full accent-brand-600"
          />
        </div>
      ) : (
        // Kept so switching back to Blended later restores the same weight.
        <input type="hidden" name="accuracyWeight" value={weight} />
      )}

      {errors.length > 0 && (
        <ul id="grading-mode-error" className="text-sm font-medium text-danger-700">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
