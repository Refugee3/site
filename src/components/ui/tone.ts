export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** Background, border and text classes for each tone (shared by Badge and Alert). */
export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-subtle border-line text-ink",
  info: "bg-info-50 border-info-200 text-info-800",
  success: "bg-success-50 border-success-200 text-success-800",
  warning: "bg-warning-50 border-warning-200 text-warning-800",
  danger: "bg-danger-50 border-danger-200 text-danger-800",
};
