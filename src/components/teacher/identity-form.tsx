"use client";

import { useState, type FormEvent } from "react";
import { updateIdentityAction } from "@/actions/review";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { Section, Submission } from "@/lib/types";
import { useReportUnsaved } from "./unsaved-edits-context";
import { useActionRunner } from "./use-action-runner";
import { useSyncedState } from "./use-synced-state";

export interface IdentityFormProps {
  submission: Pick<
    Submission,
    "id" | "studentName" | "sectionId" | "aiName" | "aiNameConfidence" | "aiSectionRaw" | "nameSource" | "sectionSource" | "gradedAt"
  >;
  sections: Section[];
}

/** Name and section as the teacher confirms them, next to what the AI read on the paper. */
export function IdentityForm({ submission: s, sections }: IdentityFormProps) {
  const storedName = s.studentName ?? "";
  const storedSection = s.sectionId ?? "";
  const [name, setName, expectSavedName] = useSyncedState(storedName);
  const [sectionId, setSectionId, expectSavedSection] = useSyncedState(storedSection);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState(false);
  const runner = useActionRunner();
  const dirty = name !== storedName || sectionId !== storedSection;
  useReportUnsaved("identity", sections.length > 0 ? "Student name/section" : "Student name", dirty);
  // Saving marks both as set by the teacher, which also clears name and section flags, so an
  // unchanged reading can be confirmed as is. Without sections only the name is confirmed.
  const confirmed = s.nameSource === "teacher" && (sections.length === 0 || s.sectionSource === "teacher");
  const subject = sections.length > 0 ? "name and section" : "name";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    setFieldErrors({});
    expectSavedName();
    expectSavedSection();
    runner.run(
      () => updateIdentityAction(s.id, { studentName: name, sectionId: sectionId === "" ? null : sectionId }),
      () => setSaved(true),
      (failure) => {
        setFieldErrors(failure.fieldErrors ?? {});
        expectSavedName(false);
        expectSavedSection(false);
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        <AiReading submission={s} />
        {confirmed && ` You have confirmed the ${subject} below.`}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Student name" htmlFor={`identity-${s.id}-name`} error={fieldErrors.studentName}>
          <Input
            id={`identity-${s.id}-name`}
            maxLength={120}
            autoComplete="off"
            readOnly={runner.pending}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {sections.length > 0 && (
          <Field label="Section" htmlFor={`identity-${s.id}-section`} error={fieldErrors.sectionId}>
            <Select
              id={`identity-${s.id}-section`}
              disabled={runner.pending}
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
            >
              <option value="">No section</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={(confirmed && !dirty) || runner.pending}>
          {runner.pending && <Spinner className="size-4" />}
          {dirty || confirmed ? `Save ${subject}` : `Confirm ${subject}`}
        </Button>
        <p role="status" className="text-sm text-success-800">
          {saved && !dirty && "Saved."}
        </p>
      </div>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </form>
  );
}

function AiReading({ submission: s }: { submission: IdentityFormProps["submission"] }) {
  if (s.gradedAt === null) return <>The AI hasn&apos;t read this paper yet.</>;
  return (
    <>
      The AI read{" "}
      {s.aiName ? (
        <>
          the name <span className="font-medium text-ink">“{s.aiName}”</span>
          {s.aiNameConfidence && ` (${s.aiNameConfidence} confidence)`}
        </>
      ) : (
        "no name"
      )}{" "}
      and{" "}
      {s.aiSectionRaw ? (
        <>
          the section <span className="font-medium text-ink">“{s.aiSectionRaw}”</span>
        </>
      ) : (
        "no section"
      )}
      .
    </>
  );
}
