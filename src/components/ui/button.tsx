import type { ComponentProps } from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button-styles";

export type ButtonProps = ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize };

/**
 * A native button. `type` defaults to "button" (not the HTML default "submit") so that row actions inside
 * a form never submit it by accident; use `SubmitButton` or `type="submit"` to submit.
 */
export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses({ variant, size, className })} {...props} />;
}
