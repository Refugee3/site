"use client";

import { useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { saveSpotsAction } from "@/actions/worksheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { defaultKindFor } from "@/lib/omr/map-key";
import { type QuestionSpots, SPOT_KINDS, type SpotBox, type SpotKind } from "@/lib/omr/types";
import type { AnswerType } from "@/lib/types";
import { RegradeSpotsButton } from "../regrade-spots-button";
import { useActionRunner } from "../use-action-runner";
import { useSyncedState } from "../use-synced-state";
import {
  boxFromDrag, type Handle, KIND_COLOR, KIND_LABEL, moveBox, newSpot, resizeBox, spotBoxes, spotTitle, unionOf, withBox, withKind,
} from "./spot-model";

export interface SpotEditorProps {
  assignmentId: string;
  /** Each page's image and size in points. */
  pages: Array<{ url: string; width: number; height: number }>;
  spots: QuestionSpots[];
  items: Array<{ label: string; answerType: AnswerType; prompt: string }>;
  confirmed: boolean;
  /** Papers graded before the latest saved spots: offered a regrade with mark detection once the spots are saved. */
  regradeCount: number;
}

/** Where a box being dragged lives in a question: an option (choice) or an area. */
interface BoxRef {
  spotId: string;
  index: number;
}

type Drag =
  | { kind: "move" | "resize"; ref: BoxRef; handle: Handle | null; start: { x: number; y: number }; original: SpotBox }
  | { kind: "draw"; page: number; start: { x: number; y: number }; current: { x: number; y: number } };

type Mode = "select" | "draw-new" | "draw-add";

const EDITABLE_QUERY = "(min-width: 768px)";

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(EDITABLE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Editing needs a mouse and room: on a phone the spots are shown, not edited. */
function useEditable(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(EDITABLE_QUERY).matches, () => false);
}

function sameSpots(a: QuestionSpots[], b: QuestionSpots[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The blank worksheet's pages with the answer spots drawn over them: drag a box to move it, drag a corner to resize it, draw
 * a new spot, and change the selected question's key item, kind and options in the panel. Saving confirms the spots.
 */
export function SpotEditor({ assignmentId, pages, spots: serverSpots, items, confirmed, regradeCount }: SpotEditorProps) {
  const editable = useEditable();
  const [spots, setSpots, expectSave] = useSyncedState(serverSpots, sameSpots);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("select");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saved, setSaved] = useState(false);
  const runner = useActionRunner();
  const svgs = useRef<Array<SVGSVGElement | null>>([]);
  const dirty = !sameSpots(spots, serverSpots);
  const selected = spots.find((s) => s.id === selectedId) ?? null;
  const itemKinds = items.map((item) => ({ label: item.label, kind: defaultKindFor(item.answerType) }));

  function update(id: string, change: (s: QuestionSpots) => QuestionSpots) {
    setSaved(false);
    setSpots(spots.map((s) => (s.id === id ? change(s) : s)));
  }

  function pointAt(page: number, e: { clientX: number; clientY: number }) {
    const rect = svgs.current[page - 1]!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }

  function boxOf(ref: BoxRef): SpotBox | null {
    const s = spots.find((x) => x.id === ref.spotId);
    return s ? (spotBoxes(s)[ref.index] ?? null) : null;
  }

  function setBox(ref: BoxRef, box: SpotBox) {
    update(ref.spotId, (s) => s.kind === "choice"
      ? { ...s, options: s.options.map((o, i) => (i === ref.index ? { ...o, box } : o)) }
      : { ...s, boxes: s.boxes.map((b, i) => (i === ref.index ? box : b)) });
  }

  function startBoxDrag(e: ReactPointerEvent, page: number, ref: BoxRef, handle: Handle | null) {
    setSelectedId(ref.spotId);
    if (!editable || mode !== "select") return;
    const original = boxOf(ref);
    if (!original) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: handle ? "resize" : "move", ref, handle, start: pointAt(page, e), original });
  }

  function startDraw(e: ReactPointerEvent, page: number) {
    if (!editable || mode === "select") {
      if (mode === "select") setSelectedId(null);
      return;
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = pointAt(page, e);
    setDrag({ kind: "draw", page, start: p, current: p });
  }

  function onMove(e: ReactPointerEvent, page: number) {
    if (!drag) return;
    const p = pointAt(page, e);
    if (drag.kind === "draw") {
      setDrag({ ...drag, current: p });
      return;
    }
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    setBox(drag.ref, drag.kind === "move" ? moveBox(drag.original, dx, dy) : resizeBox(drag.original, drag.handle!, dx, dy));
  }

  function onUp() {
    if (drag?.kind === "draw") {
      const box = boxFromDrag(drag.start, drag.current);
      if (box && mode === "draw-new") {
        const created = newSpot(spots, drag.page, box, itemKinds);
        setSaved(false);
        setSpots([...spots, created]);
        setSelectedId(created.id);
      } else if (box && mode === "draw-add" && selected) {
        update(selected.id, (s) => ({ ...withBox(s, box), page: drag.page }));
      }
      setMode("select");
    }
    setDrag(null);
  }

  function save() {
    expectSave();
    runner.run(() => saveSpotsAction(assignmentId, spots), () => setSaved(true), () => expectSave(false));
  }

  return (
    <div className="flex flex-col gap-4">
      {!editable && (
        <Alert tone="info">
          These are the answer spots found on the blank. To move, add or change them, open this page on a bigger screen.
        </Alert>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={mode === "draw-new" ? "primary" : "secondary"}
            size="sm"
            aria-pressed={mode === "draw-new"}
            onClick={() => setMode(mode === "draw-new" ? "select" : "draw-new")}
          >
            {mode === "draw-new" ? "Drag on the page to draw…" : "Draw a new answer spot"}
          </Button>
          <Button onClick={save} disabled={runner.pending || (!dirty && confirmed)} size="sm">
            {runner.pending ? "Saving…" : confirmed && !dirty ? "Saved" : "Save answer spots"}
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setSpots(serverSpots)} disabled={runner.pending}>
              Discard changes
            </Button>
          )}
          <p className="text-sm text-muted" aria-live="polite">
            {saved || (confirmed && !dirty)
              ? "Papers are read from these spots."
              : "Not saved yet: until you save, the AI reads every question as before."}
          </p>
        </div>
      )}
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
      {/* Saving refreshes the page, so the count of papers graded before these spots arrives with the save. */}
      {confirmed && <RegradeSpotsButton assignmentId={assignmentId} count={regradeCount} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,1fr)]">
        <div className="flex flex-col gap-4">
          {pages.map((page, i) => {
            const n = i + 1;
            const h = (1000 * page.height) / page.width;
            const onPage = spots.filter((s) => s.page === n);
            return (
              <figure key={page.url} className="flex flex-col gap-1">
                <figcaption className="text-sm text-muted">Page {n} of {pages.length}</figcaption>
                <div className="relative overflow-hidden rounded-lg border border-line bg-white">
                  {/* A generated, private page image; next/image would only proxy it. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={page.url} alt={`Blank worksheet, page ${n}`} className="block h-auto w-full select-none" draggable={false} />
                  <svg
                    ref={(el) => {
                      svgs.current[i] = el;
                    }}
                    viewBox={`0 0 1000 ${h}`}
                    preserveAspectRatio="none"
                    className={cx("absolute inset-0 h-full w-full touch-none select-none", mode !== "select" && editable && "cursor-crosshair")}
                    onPointerDown={(e) => startDraw(e, n)}
                    onPointerMove={(e) => onMove(e, n)}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                    role="img"
                    aria-label={`Answer spots on page ${n}: ${onPage.map(spotTitle).join("; ") || "none"}`}
                  >
                    {onPage.map((s) => (
                      <SpotShapes
                        key={s.id}
                        spot={s}
                        h={h}
                        selected={s.id === selectedId}
                        editable={editable && mode === "select"}
                        onBoxDown={(e, index, handle) => startBoxDrag(e, n, { spotId: s.id, index }, handle)}
                      />
                    ))}
                    {drag?.kind === "draw" && drag.page === n && (() => {
                      const b = boxFromDrag(drag.start, drag.current);
                      return b && (
                        <rect x={b.x * 1000} y={b.y * h} width={b.w * 1000} height={b.h * h} fill="none" stroke="var(--color-brand-600)"
                          strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                      );
                    })()}
                  </svg>
                </div>
              </figure>
            );
          })}
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          {selected ? (
            <QuestionPanel
              spot={selected}
              items={items}
              editable={editable}
              drawing={mode === "draw-add"}
              onChange={(change) => update(selected.id, change)}
              onDraw={() => setMode(mode === "draw-add" ? "select" : "draw-add")}
              onRemove={() => {
                setSaved(false);
                setSpots(spots.filter((s) => s.id !== selected.id));
                setSelectedId(null);
              }}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <QuestionList spots={spots} onSelect={setSelectedId} editable={editable} />
          )}
        </aside>
      </div>
    </div>
  );
}

function SpotShapes(props: {
  spot: QuestionSpots; h: number; selected: boolean; editable: boolean;
  onBoxDown: (e: ReactPointerEvent, index: number, handle: Handle | null) => void;
}) {
  const { spot, h, selected, editable, onBoxDown } = props;
  const boxes = spotBoxes(spot);
  const color = KIND_COLOR[spot.kind];
  const muted = !spot.enabled || spot.itemLabel === null;
  const union = unionOf(boxes);
  const handleSize = 9;
  return (
    <g opacity={muted ? 0.55 : 1}>
      {boxes.map((b, index) => (
        <g key={index}>
          <rect
            x={b.x * 1000} y={b.y * h} width={b.w * 1000} height={b.h * h}
            fill={selected ? "rgba(44, 86, 201, 0.10)" : "rgba(255, 255, 255, 0.01)"}
            stroke={color} strokeWidth={selected ? 2.5 : 1.5} strokeDasharray={muted ? "5 4" : undefined}
            vectorEffect="non-scaling-stroke"
            className={editable ? "cursor-move" : "cursor-pointer"}
            onPointerDown={(e) => onBoxDown(e, index, null)}
          />
          {spot.kind === "choice" && (
            <text x={b.x * 1000 + 3} y={b.y * h + b.h * h - 3} fontSize={11} fill={color} pointerEvents="none" className="font-semibold">
              {spot.options[index]?.value}
            </text>
          )}
          {selected && editable && (["nw", "ne", "sw", "se"] as const).map((handle) => (
            <rect
              key={handle}
              x={(handle.endsWith("w") ? b.x : b.x + b.w) * 1000 - handleSize / 2}
              y={(handle.startsWith("n") ? b.y : b.y + b.h) * h - handleSize / 2}
              width={handleSize} height={handleSize} fill="white" stroke={color} strokeWidth={1.5}
              className={handle === "nw" || handle === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize"}
              onPointerDown={(e) => onBoxDown(e, index, handle)}
            />
          ))}
        </g>
      ))}
      {union && (() => {
        // Beside the spots when the page has room there (it rarely holds printed text), else just above them.
        const title = `${spotTitle(spot)}${spot.itemLabel === null ? " (not linked)" : !spot.enabled ? " (off)" : ""}`;
        const room = 1000 - (union.x + union.w) * 1000;
        const beside = room >= title.length * 7.5 + 10;
        return (
          <text
            x={beside ? (union.x + union.w) * 1000 + 6 : union.x * 1000}
            y={beside ? union.y * h + 13 : Math.max(12, union.y * h - 4)}
            fontSize={13} fill={color} stroke="white" strokeWidth={3} paintOrder="stroke" pointerEvents="none" className="font-semibold"
          >
            {title}
          </text>
        );
      })()}
    </g>
  );
}

function QuestionList({ spots, onSelect, editable }: { spots: QuestionSpots[]; onSelect: (id: string) => void; editable: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-3 text-sm">
      <p className="font-semibold">Questions with answer spots</p>
      {spots.length === 0 ? (
        <p className="text-muted">None yet. {editable ? "Use “Draw a new answer spot”, then drag a box on the page." : ""}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {spots.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onSelect(s.id)} className="w-full rounded px-2 py-1 text-left hover:bg-surface">
                <span className="font-medium" style={{ color: KIND_COLOR[s.kind] }}>{spotTitle(s)}</span>
                <span className="text-muted"> · page {s.page}{s.itemLabel === null ? " · not linked" : ""}{!s.enabled ? " · off" : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editable && <p className="text-muted">Click a box to change it. Drag a box to move it, or a corner to resize it.</p>}
    </div>
  );
}

function QuestionPanel(props: {
  spot: QuestionSpots; items: SpotEditorProps["items"]; editable: boolean; drawing: boolean;
  onChange: (change: (s: QuestionSpots) => QuestionSpots) => void; onDraw: () => void; onRemove: () => void; onClose: () => void;
}) {
  const { spot, items, editable, drawing, onChange, onDraw, onRemove, onClose } = props;
  const id = `spot-${spot.id}`;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 text-sm shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold" style={{ color: KIND_COLOR[spot.kind] }}>{spotTitle(spot)}</p>
        <Button variant="ghost" size="sm" onClick={onClose}>Done</Button>
      </div>
      <label className="flex flex-col gap-1" htmlFor={`${id}-label`}>
        <span className="font-medium">Question label</span>
        <Input id={`${id}-label`} value={spot.label} disabled={!editable} onChange={(e) => onChange((s) => ({ ...s, label: e.target.value }))} />
      </label>
      <label className="flex flex-col gap-1" htmlFor={`${id}-item`}>
        <span className="font-medium">Key item</span>
        <Select
          id={`${id}-item`}
          value={spot.itemLabel ?? ""}
          disabled={!editable}
          onChange={(e) => onChange((s) => ({ ...s, itemLabel: e.target.value === "" ? null : e.target.value }))}
        >
          <option value="">Not linked (not used)</option>
          {items.map((item) => (
            <option key={item.label} value={item.label}>
              {item.label}{item.prompt ? ` — ${item.prompt.slice(0, 50)}` : ""}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1" htmlFor={`${id}-kind`}>
        <span className="font-medium">How it is answered</span>
        <Select id={`${id}-kind`} value={spot.kind} disabled={!editable} onChange={(e) => onChange((s) => withKind(s, e.target.value as SpotKind))}>
          {SPOT_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
        </Select>
      </label>
      <label className="flex items-center gap-2">
        <Input type="checkbox" checked={spot.enabled} disabled={!editable} onChange={(e) => onChange((s) => ({ ...s, enabled: e.target.checked }))} />
        Use mark detection
      </label>
      {spot.kind === "choice" && (
        <>
          <label className="flex items-center gap-2">
            <Input type="checkbox" checked={spot.multi} disabled={!editable} onChange={(e) => onChange((s) => ({ ...s, multi: e.target.checked }))} />
            Several options can be right
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="font-medium">Options (what each box stands for)</legend>
            {spot.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Option ${i + 1}`}
                  value={o.value}
                  disabled={!editable}
                  className="min-w-0 flex-1"
                  onChange={(e) => onChange((s) => ({ ...s, options: s.options.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) }))}
                />
                {editable && (
                  <Button variant="ghost" size="sm" aria-label={`Remove option ${o.value}`}
                    onClick={() => onChange((s) => ({ ...s, options: s.options.filter((_, k) => k !== i) }))}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </fieldset>
        </>
      )}
      {spot.kind !== "choice" && (
        <>
          <p className="text-muted">
            {spot.boxes.length === 1 ? "1 answer area" : `${spot.boxes.length} answer areas`}. Empty areas are marked “no answer”;
            written ones are cropped and only the crop is read.
          </p>
          {editable && spot.boxes.length > 1 && (
            <ul className="flex flex-col gap-1">
              {spot.boxes.map((_, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span>Area {i + 1}</span>
                  <Button variant="ghost" size="sm" onClick={() => onChange((s) => ({ ...s, boxes: s.boxes.filter((__, k) => k !== i) }))}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant={drawing ? "primary" : "secondary"} size="sm" onClick={onDraw} aria-pressed={drawing}>
            {drawing ? "Drag on the page…" : spot.kind === "choice" ? "Draw another option" : "Draw another area"}
          </Button>
          <Button variant="danger" size="sm" onClick={onRemove}>Remove this question&apos;s spots</Button>
        </div>
      )}
    </div>
  );
}
