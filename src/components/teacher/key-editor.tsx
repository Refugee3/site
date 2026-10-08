"use client";

import { useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { saveKeyAction } from "@/actions/key";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LinkButton } from "@/components/ui/link-button";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { moveItem } from "@/lib/client/upload-files";
import { ANSWER_TYPE_LABEL, formatPoints, uploadLabel } from "@/lib/format";
import { ANSWER_TYPES, type AnswerType, type AssignmentKind, type AssignmentStatus, type KeyItem } from "@/lib/types";
import { boardHref } from "./board-helpers";
import {
  buildSaveKeyInput, describeErrors, draftFromItem, draftsSnapshot, isUncertain, needsAcknowledgement, newDraftRow,
  rowErrors, totalPointsCenti, type DraftRow, type FieldErrors, type RowField,
} from "./key-rows";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";
import { useLeaveGuard } from "./use-leave-guard";

export interface KeyEditorProps {
  assignmentId: string;
  assignmentStatus: AssignmentStatus;
  items: KeyItem[];
  teacherNotes: string;
  /** The stored key's `updatedAt`: when it changes (after a save), the editor reloads from `items`. */
  version: number;
  approved: boolean;
  /** Papers already graded or awaiting review with the current key. */
  gradedCount: number;
  /** Off: no "Save & open"; once approved, the next step is uploading the papers. */
  studentsCanUpload: boolean;
  kind: AssignmentKind;
}

// Dense controls from the sm breakpoint up; phones keep 44 px targets and 16 px text (no zoom on focus).
const DENSE = "sm:min-h-9 sm:py-1.5 sm:text-sm";

function initialRows(items: KeyItem[]): DraftRow[] {
  return items.length > 0 ? items.map(draftFromItem) : [newDraftRow("new-0")];
}

/** The answer-key table: one card per gradable item, with the save bar pinned to the bottom of the screen. */
export function KeyEditor(props: KeyEditorProps) {
  const { assignmentId, assignmentStatus, items, teacherNotes, version, approved, gradedCount, studentsCanUpload, kind } = props;
  const router = useRouter();
  const runner = useActionRunner();
  const [rows, setRows] = useState(() => initialRows(items));
  const [notes, setNotes] = useState(teacherNotes);
  const [acknowledged, setAcknowledged] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [loadedVersion, setLoadedVersion] = useState(version);
  const nextKey = useRef(1);

  // A save stored a new version of the key: reload it, so new rows get their ids and AI-proposed rows their new source.
  if (version !== loadedVersion) {
    setLoadedVersion(version);
    setRows(initialRows(items));
    setNotes(teacherNotes);
    setAcknowledged(false);
    setFieldErrors({});
  }

  const baseline = useMemo(() => draftsSnapshot(initialRows(items), teacherNotes), [items, teacherNotes]);
  const dirty = draftsSnapshot(rows, notes) !== baseline;
  const needsAck = needsAcknowledgement(rows);
  const errorsByRow = useMemo(
    () => Array.from({ length: rows.length }, (_, index) => rowErrors(fieldErrors, index)),
    [fieldErrors, rows.length],
  );
  const errorLines = describeErrors(fieldErrors, rows);

  useLeaveGuard(dirty, "Your answer-key edits are not saved. Leave and lose them?");

  const updateRow = useCallback((key: string, patch: Partial<DraftRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }, []);

  // Errors are keyed by row index, so they are dropped whenever rows are added, removed or reordered.
  const restructure = useCallback((change: (current: DraftRow[]) => DraftRow[]) => {
    setRows(change);
    setFieldErrors({});
  }, []);

  const moveRow = useCallback(
    (key: string, offset: -1 | 1) =>
      restructure((current) => moveItem(current, current.findIndex((row) => row.key === key), offset)),
    [restructure],
  );

  const insertAfter = useCallback(
    (key: string | null) => {
      const newKey = `new-${nextKey.current++}`;
      restructure((current) => {
        const index = key === null ? current.length - 1 : current.findIndex((row) => row.key === key);
        return [...current.slice(0, index + 1), newDraftRow(newKey, current[index]), ...current.slice(index + 1)];
      });
    },
    [restructure],
  );

  const removeRow = useCallback(
    (row: DraftRow) => {
      const loses = row.id !== null && gradedCount > 0;
      if (loses && !window.confirm(`Remove item ${row.label || "without a label"}? Points you entered for it on graded papers are deleted when you save.`)) {
        return;
      }
      restructure((current) => current.filter((r) => r.key !== row.key));
    },
    [gradedCount, restructure],
  );

  function setAllPoints(pointsText: string) {
    setRows((current) => current.map((row) => ({ ...row, pointsText })));
  }

  function save(goToSubmissions: boolean) {
    setSavedMessage(null);
    const built = buildSaveKeyInput(rows, notes, acknowledged);
    if (!built.ok) {
      setFieldErrors(built.fieldErrors);
      return;
    }
    setFieldErrors({});
    // Opening is part of "Save & open" only for a draft; a closed assignment stays closed.
    const open = goToSubmissions && assignmentStatus === "draft";
    runner.run(
      () => saveKeyAction(assignmentId, built.input, { open }),
      (result) => {
        if (goToSubmissions) router.push(boardHref(assignmentId, "all"));
        else setSavedMessage(savedText(result.data?.staleCount ?? 0));
      },
      (failure) => setFieldErrors(failure.fieldErrors ?? {}),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Locked while saving: the saved key replaces every row when it comes back, so later typing would be lost. */}
      <fieldset disabled={runner.pending} className="flex min-w-0 flex-col gap-4">
        <Field
          label="Teacher's notes for grading"
          htmlFor="key-teacher-notes"
          hint="The AI reads these with every paper, e.g. “Units are required on word problems” or “Accept any reasonable synonym”."
          error={fieldErrors.teacherNotes}
        >
          <Textarea
            id="key-teacher-notes"
            rows={3}
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        {gradedCount > 0 && (
          <Alert tone="info">
            {plural(gradedCount, "paper")} {gradedCount === 1 ? "is" : "are"} already graded. Points and partial-credit
            changes rescore them at once; changes to questions, answers, criteria or notes mark them stale so you can
            regrade them.
          </Alert>
        )}

        <Toolbar rows={rows} onSetAllPoints={setAllPoints} onAdd={() => insertAfter(null)} />

        <ol className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <KeyRowCard
              key={row.key}
              row={row}
              index={index}
              count={rows.length}
              errors={errorsByRow[index]}
              onChange={updateRow}
              onMove={moveRow}
              onInsertAfter={insertAfter}
              onRemove={removeRow}
            />
          ))}
        </ol>

        <Button variant="secondary" className="self-start" onClick={() => insertAfter(null)}>
          + Add item
        </Button>
      </fieldset>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-line bg-surface/95 px-4 py-3 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        {(errorLines.length > 0 || runner.error) && (
          <Alert tone="danger" title={errorLines.length > 0 ? "Fix these before saving" : runner.error}>
            {errorLines.length > 0 && <ErrorList lines={errorLines} />}
          </Alert>
        )}
        {needsAck && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <Input
              type="checkbox"
              disabled={runner.pending}
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              aria-invalid={fieldErrors.acknowledgeAiProposed ? true : undefined}
            />
            <span className="font-medium">I checked the AI-proposed answers</span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={runner.pending} onClick={() => save(false)}>
            {runner.pending && <Spinner className="size-4" />}
            {studentsCanUpload ? "Save" : "Save answer key"}
          </Button>
          {studentsCanUpload && (
            <Button variant="secondary" disabled={runner.pending} onClick={() => save(true)}>
              {assignmentStatus === "draft" ? "Save & open submissions" : "Save & view submissions"}
            </Button>
          )}
          <p role="status" className="text-sm text-muted">
            {saveStatus({ pending: runner.pending, dirty, approved, savedMessage })}
          </p>
          {!studentsCanUpload && approved && !dirty && !runner.pending && (
            <LinkButton href={`/teacher/assignments/${assignmentId}/upload`} variant="secondary" size="sm">
              {uploadLabel(kind)} →
            </LinkButton>
          )}
        </div>
      </div>
    </div>
  );
}

function savedText(staleCount: number): string {
  if (staleCount === 0) return "Saved. The key is approved.";
  const papers = plural(staleCount, "paper");
  return `Saved. ${papers} ${staleCount === 1 ? "was" : "were"} graded with an earlier version of the key — regrade them from Submissions.`;
}

function saveStatus(s: { pending: boolean; dirty: boolean; approved: boolean; savedMessage: string | null }): string {
  if (s.pending) return "Saving…";
  if (s.dirty) return "Unsaved changes.";
  if (s.savedMessage) return s.savedMessage;
  return s.approved ? "Saved and approved." : "Not approved yet: saving approves the key for grading.";
}

const MAX_ERROR_LINES = 8;

function ErrorList({ lines }: { lines: string[] }) {
  const hidden = lines.length - MAX_ERROR_LINES;
  return (
    <ul className="list-disc pl-5">
      {lines.slice(0, MAX_ERROR_LINES).map((line) => (
        <li key={line}>{line}</li>
      ))}
      {hidden > 0 && <li>…and {hidden} more, marked below.</li>}
    </ul>
  );
}

function Toolbar({ rows, onSetAllPoints, onAdd }: { rows: DraftRow[]; onSetAllPoints: (text: string) => void; onAdd: () => void }) {
  const [points, setPoints] = useState("");
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="text-sm font-medium">
        {plural(rows.length, "item")} · {formatPoints(totalPointsCenti(rows))} points in total
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="key-all-points" className="text-xs font-medium text-muted">
            Points for every item
          </label>
          <div className="w-24">
            <Input id="key-all-points" inputMode="decimal" className={DENSE} value={points} onChange={(e) => setPoints(e.target.value)} />
          </div>
        </div>
        <Button variant="secondary" size="sm" disabled={points.trim() === ""} onClick={() => onSetAllPoints(points.trim())}>
          Apply to all
        </Button>
        <Button variant="secondary" size="sm" onClick={onAdd}>
          + Add item
        </Button>
      </div>
    </div>
  );
}

interface KeyRowCardProps {
  row: DraftRow;
  index: number;
  count: number;
  errors: Partial<Record<RowField, string[]>>;
  onChange: (key: string, patch: Partial<DraftRow>) => void;
  onMove: (key: string, offset: -1 | 1) => void;
  onInsertAfter: (key: string) => void;
  onRemove: (row: DraftRow) => void;
}

// Memoized with stable callbacks so typing in one card re-renders that card only, even with 50 items.
const KeyRowCard = memo(function KeyRowCard({ row, index, count, errors, onChange, onMove, onInsertAfter, onRemove }: KeyRowCardProps) {
  const id = (field: string) => `key-${row.key}-${field}`;
  const set = (patch: Partial<DraftRow>) => onChange(row.key, patch);
  const name = row.label.trim() || `#${index + 1}`;
  const uncertain = isUncertain(row);

  return (
    <li
      aria-label={`Item ${name}`}
      className={cx(
        "flex flex-col gap-3 rounded-xl border p-3 shadow-sm sm:p-4",
        uncertain ? "border-warning-200 bg-warning-50" : "border-line bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-muted">{index + 1}.</span>
          {row.answerSource === "ai_proposed" && <Badge tone="warning">AI-proposed — check</Badge>}
          {uncertain && <Badge tone="warning">{row.aiConfidence === "low" ? "Low" : "Medium"} AI confidence</Badge>}
          {row.id === null && <Badge tone="info">New</Badge>}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(row.key, -1)} aria-label={`Move item ${name} up`}>
            ↑
          </Button>
          <Button variant="ghost" size="sm" disabled={index === count - 1} onClick={() => onMove(row.key, 1)} aria-label={`Move item ${name} down`}>
            ↓
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onInsertAfter(row.key)} aria-label={`Insert an item after ${name}`}>
            + Below
          </Button>
          <Button variant="ghost" size="sm" disabled={count === 1} onClick={() => onRemove(row)} aria-label={`Remove item ${name}`}>
            Remove
          </Button>
        </div>
      </div>

      {row.aiNote && <p className="whitespace-pre-wrap text-sm text-warning-800">AI note: {row.aiNote}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[6rem_6rem_minmax(0,1fr)_6rem_5rem]">
        <Field label="Label" htmlFor={id("label")} error={errors.label}>
          <Input id={id("label")} maxLength={40} className={DENSE} value={row.label} onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field label="Group" htmlFor={id("group")} error={errors.groupLabel}>
          <Input
            id={id("group")}
            maxLength={40}
            placeholder="e.g. 3"
            className={DENSE}
            value={row.groupLabel}
            onChange={(e) => set({ groupLabel: e.target.value })}
          />
        </Field>
        <div className="col-span-2 sm:col-span-1">
          <Field label="Type" htmlFor={id("type")} error={errors.answerType}>
            <Select id={id("type")} className={DENSE} value={row.answerType} onChange={(e) => set({ answerType: e.target.value as AnswerType })}>
              {ANSWER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ANSWER_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Points" htmlFor={id("points")} error={errors.pointsCenti}>
          <Input id={id("points")} inputMode="decimal" className={DENSE} value={row.pointsText} onChange={(e) => set({ pointsText: e.target.value })} />
        </Field>
        <Field label="Page" htmlFor={id("page")} error={errors.page}>
          <Input id={id("page")} inputMode="numeric" className={DENSE} value={row.pageText} onChange={(e) => set({ pageText: e.target.value })} />
        </Field>
      </div>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 self-start sm:min-h-9">
        <Input type="checkbox" checked={row.partialCredit} onChange={(e) => set({ partialCredit: e.target.checked })} />
        <span className="text-sm">
          Partial credit <span className="text-muted">(minor slips and partly right answers earn some accuracy credit)</span>
        </span>
      </label>

      <Field label="Question" htmlFor={id("prompt")} error={errors.prompt}>
        <Textarea id={id("prompt")} rows={2} maxLength={1000} className={DENSE} value={row.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </Field>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Expected answer" htmlFor={id("expected")} error={errors.expectedAnswer}>
          <Textarea
            id={id("expected")}
            rows={2}
            maxLength={2000}
            className={DENSE}
            value={row.expectedAnswer}
            onChange={(e) => set({ expectedAnswer: e.target.value })}
          />
        </Field>
        <Field label="Also accept (one per line)" htmlFor={id("accept")} error={errors.acceptableAnswers}>
          <Textarea
            id={id("accept")}
            rows={2}
            className={DENSE}
            value={row.acceptableText}
            onChange={(e) => set({ acceptableText: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Grading criteria" htmlFor={id("criteria")} error={errors.gradingCriteria}>
        <Textarea
          id={id("criteria")}
          rows={2}
          maxLength={1000}
          placeholder="e.g. Must show work; units required"
          className={DENSE}
          value={row.gradingCriteria}
          onChange={(e) => set({ gradingCriteria: e.target.value })}
        />
      </Field>
    </li>
  );
});
