import type { ComponentProps } from "react";
import { CONTROL_CLASSES } from "./control-styles";
import { cx } from "./cx";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(CONTROL_CLASSES, "leading-relaxed", className)} {...props} />;
}
