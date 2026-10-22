import type { SpotProposal } from "@/lib/ai/schemas";
import type { AnswerType } from "@/lib/types";
import { defaultKindFor } from "./map-key";
import { clampBox, normalizeLabel } from "./text-zones";
import type { QuestionSpots, SpotBox } from "./types";

// The AI's proposal for a scanned blank page (pixel boxes in the image it saw) as answer spots (pure). Boxes are clamped to
// the page, tiny or inverted ones dropped, option labels tidied ("(b)" → "B", "T" → "True"), and each question linked to the
// key item with its label, whose answer type decides between a choice and a write-in when the AI's guess disagrees with it.

export function proposalToSpots(
  proposal: SpotProposal, o: { page: number; width: number; height: number; items: Array<{ label: string; answerType: AnswerType }>; firstId: number },
): QuestionSpots[] {
  const keyByLabel = new Map(o.items.map((item) => [normalizeLabel(item.label), item]));
  const toBox = (b: number[] | null): SpotBox | null => {
    if (!b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return null;
    const [x0, y0, x1, y1] = b;
    const box = clampBox({ x: Math.min(x0, x1) / o.width, y: Math.min(y0, y1) / o.height, w: Math.abs(x1 - x0) / o.width, h: Math.abs(y1 - y0) / o.height });
    return box.w >= 0.005 && box.h >= 0.004 ? box : null;
  };
  const spots: QuestionSpots[] = [];
  for (const q of proposal.questions) {
    const label = q.label.trim().slice(0, 40);
    if (label === "") continue;
    const keyItem = keyByLabel.get(normalizeLabel(label)) ?? null;
    let options = q.options.flatMap((opt) => {
      const box = toBox(opt.box);
      return box ? [{ value: optionValue(opt.label), box }] : [];
    });
    // Options printed "T" and "F" stand for True and False.
    if (options.length === 2 && options.every((opt) => /^(T|F|True)$/.test(opt.value))) {
      options = options.map((opt) => ({ ...opt, value: opt.value === "F" ? "False" : "True" }));
    }
    const answerBox = toBox(q.answer_box);
    const wanted = keyItem ? defaultKindFor(keyItem.answerType) : q.kind;
    const id = `s${o.firstId + spots.length}`;
    const common = { id, label, itemLabel: keyItem?.label ?? null, multi: false, enabled: true, page: o.page };
    if ((wanted === "choice" || !answerBox) && options.length >= 2) {
      spots.push({ ...common, kind: "choice", options, boxes: [] });
    } else if (answerBox) {
      spots.push({ ...common, kind: wanted === "choice" ? "write_in" : wanted, options: [], boxes: [answerBox] });
    }
  }
  return spots;
}

/** "(b)" → "B", "2." → "2", "true" → "True", "yes" → "Yes"; other words as printed. */
export function optionValue(label: string): string {
  const s = label.trim().replace(/^[([]+|[)\].:]+$/g, "").trim();
  if (/^[a-j]$/i.test(s)) return s.toUpperCase();
  if (/^true$/i.test(s)) return "True";
  if (/^false$/i.test(s)) return "False";
  if (/^yes$/i.test(s)) return "Yes";
  if (/^no$/i.test(s)) return "No";
  return s.slice(0, 40) || label.trim().slice(0, 40);
}
