"use client";

import { useActionState, useState } from "react";
import { loginAction } from "@/actions/auth";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/types";

/** `next` is passed through untouched; the action only follows it when it starts with "/teacher". */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(loginAction, null);
  // Controlled so a failed attempt keeps the email (React resets uncontrolled fields after an action).
  const [email, setEmail] = useState("");
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      {failure && <Alert tone="danger">{failure.error}</Alert>}
      <Field label="Email" htmlFor="login-email" error={failure?.fieldErrors?.email}>
        <Input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password" htmlFor="login-password" error={failure?.fieldErrors?.password}>
        <Input id="login-password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton pendingText="Logging in…" className="w-full">
        Log in
      </SubmitButton>
    </form>
  );
}
