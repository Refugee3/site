import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button-styles";

export type LinkButtonProps = Omit<ComponentProps<"a">, "href"> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/** A link styled as a button. */
export function LinkButton({ href, variant, size, className, children, ...props }: LinkButtonProps) {
  const classes = buttonClasses({ variant, size, className });
  // Route handlers (CSV export, PDFs) and other origins are not pages, so client-side navigation does not apply.
  if (href.startsWith("/api/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return (
      <a href={href} className={classes} {...props}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...props}>
      {children}
    </Link>
  );
}
