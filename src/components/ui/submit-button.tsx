"use client";

import { useFormStatus } from "react-dom";
import type { ButtonProps } from "./button";
import { buttonClasses } from "./button-styles";
import { Spinner } from "./spinner";

export type SubmitButtonProps = Omit<ButtonProps, "type"> & { pendingText?: string };

/** Submits the enclosing form and shows a spinner (and `pendingText`) while its action runs. */
export function SubmitButton({
  pendingText,
  variant,
  size,
  className,
  disabled,
  children,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonClasses({ variant, size, className })}
      {...props}
    >
      {pending && <Spinner className="size-4" />}
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
