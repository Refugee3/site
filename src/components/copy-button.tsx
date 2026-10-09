"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ButtonSize, ButtonVariant } from "@/components/ui/button-styles";

export interface CopyButtonProps {
  value: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

type CopyState = "idle" | "copied" | "failed";

/** The Clipboard API only exists in secure contexts; plain-http classroom servers need the legacy path. */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: fall through to the legacy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px"; // keeps iOS from zooming when the textarea takes focus
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length); // iOS ignores select()
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function CopyButton({ value, label = "Copy", variant = "secondary", size = "sm" }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), state === "copied" ? 2000 : 5000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const onClick = async () => setState((await copyText(value)) ? "copied" : "failed");

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button variant={variant} size={size} onClick={onClick}>
        {state === "copied" ? "Copied" : label}
      </Button>
      <span aria-live="polite" className="text-sm text-muted">
        {state === "copied" && <span className="sr-only">Copied to the clipboard</span>}
        {state === "failed" && "Couldn't copy. Select the text and copy it yourself."}
      </span>
    </span>
  );
}
