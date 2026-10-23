import { isIdentityKind, type QuestionSpots, type SpotBox, type SpotKind } from "@/lib/omr/types";

// The answer-spot editor's pure helpers: labels, colours, dragging and resizing boxes in normalized page coordinates, and
// the edits the side panel makes to one question's spots.

export const KIND_LABEL: Record<SpotKind, string> = {
  choice: "Circle / tick an option",
  write_in: "Written answer",
  matching: "Matching (letters in blanks)",
  diagram: "Drawing",
  name: "Student's name",
  section: "Class / period / section",
};

/** SVG stroke colours by kind (theme tokens where there is one). */
export const KIND_COLOR: Record<SpotKind, string> = {
  choice: "var(--color-brand-600)",
  write_in: "var(--color-success-600)",
  matching: "var(--color-warning-500)",
  diagram: "#7c3aed",
  name: "#0e7490",
  section: "#0e7490",
};

/** "Q3: A B C D", "Q5: write-in", "Q4: drawing" (Q + the question label as printed). */
export function spotTitle(s: Pick<QuestionSpots, "label" | "kind" | "options">): string {
  const name = /^\d/.test(s.label) ? `Q${s.label}` : s.label;
  switch (s.kind) {
    case "choice":
      return `${name}: ${s.options.map((o) => o.value).join(" ") || "no options yet"}`;
    case "write_in":
      return `${name}: write-in`;
    case "matching":
      return `${name}: matching`;
    case "diagram":
      return `${name}: drawing`;
    case "name":
      return "Student's name";
    case "section":
      return `${s.label || "Class"}: class / period`;
  }
}

/** Every box of a question (its options' or its areas). */
export function spotBoxes(s: QuestionSpots): SpotBox[] {
  return s.kind === "choice" ? s.options.map((o) => o.box) : s.boxes;
}

export function unionOf(boxes: SpotBox[]): SpotBox | null {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const MIN = 0.008;

/** A box moved by (dx, dy), kept on the page. */
export function moveBox(b: SpotBox, dx: number, dy: number): SpotBox {
  return { ...b, x: clamp(b.x + dx, 0, 1 - b.w), y: clamp(b.y + dy, 0, 1 - b.h) };
}

export type Handle = "nw" | "ne" | "sw" | "se";

/** A box resized by dragging one corner by (dx, dy), at least MIN on each side, kept on the page. */
export function resizeBox(b: SpotBox, handle: Handle, dx: number, dy: number): SpotBox {
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  if (handle === "nw" || handle === "sw") x0 = clamp(x0 + dx, 0, x1 - MIN);
  else x1 = clamp(x1 + dx, x0 + MIN, 1);
  if (handle === "nw" || handle === "ne") y0 = clamp(y0 + dy, 0, y1 - MIN);
  else y1 = clamp(y1 + dy, y0 + MIN, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The box between two drag points; null when it is too small to be meant. */
export function boxFromDrag(a: { x: number; y: number }, b: { x: number; y: number }): SpotBox | null {
  const x0 = clamp(Math.min(a.x, b.x), 0, 1);
  const y0 = clamp(Math.min(a.y, b.y), 0, 1);
  const x1 = clamp(Math.max(a.x, b.x), 0, 1);
  const y1 = clamp(Math.max(a.y, b.y), 0, 1);
  return x1 - x0 >= MIN && y1 - y0 >= MIN ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The kind changed: a choice keeps its options' area as one answer area, an area becomes two options side by side. */
export function withKind(s: QuestionSpots, kind: SpotKind): QuestionSpots {
  if (kind === s.kind) return s;
  // An identity spot (the name, the class) is never linked to a key item.
  if (isIdentityKind(kind)) {
    const area = s.kind === "choice" ? (unionOf(s.options.map((o) => o.box)) ?? { x: 0.1, y: 0.05, w: 0.4, h: 0.04 }) : (unionOf(s.boxes) ?? { x: 0.1, y: 0.05, w: 0.4, h: 0.04 });
    return { ...s, kind, itemLabel: null, multi: false, options: [], boxes: [area], label: kind === "name" ? "Name" : "Class" };
  }
  if (kind === "choice") {
    const area = unionOf(s.boxes) ?? { x: 0.1, y: 0.1, w: 0.3, h: 0.04 };
    const half = area.w / 2;
    return {
      ...s, kind, boxes: [],
      options: [{ value: "A", box: { ...area, w: half } }, { value: "B", box: { ...area, x: area.x + half, w: half } }],
    };
  }
  const boxes = s.kind === "choice" ? [unionOf(s.options.map((o) => o.box)) ?? { x: 0.1, y: 0.1, w: 0.3, h: 0.04 }] : s.boxes;
  return { ...s, kind, multi: false, options: [], boxes };
}

/** The next option value after the question's last: B after A, 3 after 2, else the next letter. */
export function nextOptionValue(s: QuestionSpots): string {
  const last = s.options.at(-1)?.value ?? "";
  if (/^\d+$/.test(last)) return String(Number(last) + 1);
  if (/^[A-Y]$/.test(last)) return String.fromCharCode(last.charCodeAt(0) + 1);
  return String.fromCharCode(65 + s.options.length);
}

/** A box added to a question: an option of a choice, else another answer area. */
export function withBox(s: QuestionSpots, box: SpotBox): QuestionSpots {
  return s.kind === "choice" ? { ...s, options: [...s.options, { value: nextOptionValue(s), box }] } : { ...s, boxes: [...s.boxes, box] };
}

/** A new question's spots drawn by the teacher: linked to the first key item without spots, of the kind its answer suggests. */
export function newSpot(
  spots: QuestionSpots[], page: number, box: SpotBox, items: Array<{ label: string; kind: SpotKind }>,
): QuestionSpots {
  const taken = new Set(spots.map((s) => s.itemLabel));
  const item = items.find((i) => !taken.has(i.label)) ?? null;
  const id = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const base: QuestionSpots = {
    id, label: item?.label ?? String(spots.length + 1), itemLabel: item?.label ?? null, kind: "write_in", multi: false, enabled: true,
    page, options: [], boxes: [box],
  };
  return item ? withKind(base, item.kind) : base;
}

/** For the card's summary: how many questions have spots, by kind, and which key items have none. */
export function summarize(spots: QuestionSpots[], itemLabels: string[]): { used: number; choice: number; written: number; missing: string[] } {
  const used = spots.filter((s) => s.enabled && s.itemLabel !== null);
  const linked = new Set(used.map((s) => s.itemLabel));
  return {
    used: used.length,
    choice: used.filter((s) => s.kind === "choice").length,
    written: used.filter((s) => s.kind !== "choice").length,
    missing: itemLabels.filter((label) => !linked.has(label)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
