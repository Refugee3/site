import { formatPoints, parsePointsInput } from "@/lib/format";

export type PointsInput = { ok: true; centi: number | null } | { ok: false; error: string };

export const POINTS_FORMAT_ERROR = "Enter a number such as 2 or 1.5 (at most two decimals).";

/** An override typed by the teacher: blank clears it; otherwise a number from 0 up to `maxCenti`. */
export function parsePointsOverride(text: string, maxCenti: number): PointsInput {
  const centi = parsePointsInput(text);
  if (centi === null) return { ok: true, centi: null };
  if (Number.isNaN(centi)) return { ok: false, error: POINTS_FORMAT_ERROR };
  if (centi > maxCenti) return { ok: false, error: `Enter at most ${formatPoints(maxCenti)} points.` };
  return { ok: true, centi };
}

/** The text an override input starts with: empty when there is no override. */
export function pointsInputText(centi: number | null): string {
  return centi === null ? "" : formatPoints(centi);
}
