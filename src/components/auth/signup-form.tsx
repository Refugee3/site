"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import { signupAction } from "@/actions/auth";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/types";

export function SignupForm({ codeRequired }: { codeRequired: boolean }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(signupAction, null);
  // Controlled so a failed attempt keeps what was typed (React resets uncontrolled fields after an action).
  const [values, setValues] = useState({ displayName: "", email: "", code: "" });
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const bind = (key: keyof typeof values) => ({
    name: key,
    value: values[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value })),
  });

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {failure && <Alert tone="danger">{failure.error}</Alert>}
      <Field
        label="Your name"
        htmlFor="signup-name"
        hint="Students see this on the upload page."
        error={errors.displayName}
      >
        <Input id="signup-name" autoComplete="name" required maxLength={100} {...bind("displayName")} />
      </Field>
      <Field label="Email" htmlFor="signup-email" error={errors.email}>
        <Input id="signup-email" type="email" autoComplete="email" required {...bind("email")} />
      </Field>
      <Field label="Password" htmlFor="signup-password" hint="At least 10 characters." error={errors.password}>
        <Input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={200}
        />
      </Field>
      {codeRequired && (
        <Field
          label="Signup code"
          htmlFor="signup-code"
          hint="Ask the person who runs this server."
          error={errors.code}
        >
          <Input id="signup-code" autoComplete="off" required {...bind("code")} />
        </Field>
      )}
      <SubmitButton pendingText="Creating account…" className="w-full">
        Create account
      </SubmitButton>
    </form>
  );
}
