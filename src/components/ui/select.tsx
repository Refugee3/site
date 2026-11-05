import type { ComponentProps } from "react";
import { CONTROL_CLASSES } from "./control-styles";
import { cx } from "./cx";

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(CONTROL_CLASSES, "pr-8", className)} {...props} />;
}
