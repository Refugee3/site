"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/** The start page's code box. A plain GET to /go, which normalizes the code and redirects to /s/CODE. */
export function CodeEntryForm({ invalid }: { invalid: boolean }) {
  const [code, setCode] = useState("");
  return (
    <form action="/go" method="get" className="flex flex-col gap-4">
      <Field
        label="Assignment code"
        htmlFor="code"
        hint="6 letters and numbers, for example K7M4QX"
        error={invalid ? ["That code doesn't look right. Check it and try again."] : undefined}
      >
        <input
          id="code"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          required
          maxLength={12}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className={
            "block min-h-14 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-center font-mono " +
            "text-2xl tracking-[0.25em] text-ink uppercase shadow-xs focus:border-brand-600 focus:outline-2 " +
            "focus:outline-offset-0 focus:outline-brand-600/40 aria-[invalid=true]:border-danger-600"
          }
        />
      </Field>
      <Button type="submit" size="lg" className="w-full">
        Continue
      </Button>
    </form>
  );
}
