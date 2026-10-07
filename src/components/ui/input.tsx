import type { ComponentProps } from "react";
import { CONTROL_CLASSES } from "./control-styles";
import { cx } from "./cx";

const CHECK_CLASSES = "size-5 shrink-0 rounded border-line-control accent-brand-600";

/** A native input. Checkboxes and radios get a compact style instead of the full-width text look. */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  const isCheck = type === "checkbox" || type === "radio";
  return <input type={type} className={cx(isCheck ? CHECK_CLASSES : CONTROL_CLASSES, className)} {...props} />;
}
