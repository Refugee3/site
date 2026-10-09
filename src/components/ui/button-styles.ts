import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium no-underline transition-colors select-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800",
  secondary: "border border-line-strong bg-surface text-ink shadow-sm hover:bg-subtle",
  danger: "bg-danger-600 text-white shadow-sm hover:bg-danger-700 active:bg-danger-800",
  ghost: "text-brand-700 hover:bg-brand-50",
};

// Every size keeps a 44 px tap target on phones; "sm" only gets denser from the sm breakpoint up.
// "lg" is for the one big action of a phone-first page.
const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 py-1.5 text-sm sm:min-h-9",
  md: "min-h-11 px-4 py-2 text-base",
  lg: "min-h-14 px-6 py-3 text-lg",
};

/** Classes for anything that should look like a button (buttons, links, file-picker labels). */
export function buttonClasses(o: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cx(BASE, VARIANTS[o.variant ?? "primary"], SIZES[o.size ?? "md"], o.className);
}
