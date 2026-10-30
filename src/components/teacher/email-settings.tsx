"use client";

import { useActionState, useState } from "react";
import { removeEmailSettingsAction, saveEmailSettingsAction, sendTestEmailAction, setEmailNotificationsAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ActionResult } from "@/lib/types";
import { useActionRunner } from "./use-action-runner";

export interface EmailSettingsProps {
  view: {
    configured: boolean; host: string; port: number | null; security: "tls" | "starttls" | "none"; user: string; hasPassword: boolean;
    from: string; publicUrl: string; publicUrlFromEnv: string | null; lastSentAt: number | null; lastError: string | null;
    lastErrorAt: number | null;
  };
  /** The signed-in teacher's address and whether they want the emails. */
  teacherEmail: string;
  notify: boolean;
  /** This page's own address, suggested for the links in emails. */
  suggestedUrl: string;
}

const PRESETS = [
  { label: "Gmail", host: "smtp.gmail.com", port: 465, security: "tls" as const },
  { label: "Outlook / Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls" as const },
];

/**
 * Settings → "Email when grading is done": the teacher's own on/off switch, then the server's outgoing mail account
 * (shared by every teacher on this server), a test email, and the last send's result.
 */
export function EmailSettings({ view, teacherEmail, notify, suggestedUrl }: EmailSettingsProps) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(saveEmailSettingsAction, null);
  const tester = useActionRunner();
  const toggler = useActionRunner();
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [host, setHost] = useState(view.host);
  const [port, setPort] = useState(view.port === null ? "" : String(view.port));
  const [security, setSecurity] = useState(view.security);
  const [on, setOn] = useState(notify);
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        Upload your papers and close the tab: grading carries on here, and you get an email when it&apos;s done (and when an answer
        key is ready to check). This computer has to stay on.
      </p>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-brand-600"
          checked={on}
          disabled={toggler.pending}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            toggler.run(() => setEmailNotificationsAction(next), undefined, () => setOn(!next));
          }}
        />
        <span>
          <span className="font-medium">Email me when grading is done</span>
          <span className="block text-sm text-muted">Sent to {teacherEmail}, for your own homework and quizzes.</span>
        </span>
      </label>
      {toggler.error && <Alert tone="danger">{toggler.error}</Alert>}

      <div className="flex flex-col gap-4 border-t border-line pt-5">
        <div className="flex flex-col gap-1">
          <h3 className="font-serif text-base font-semibold">Mail account the emails are sent from</h3>
          <p className="text-sm text-muted">
            {view.configured
              ? <>Set up. Emails come from <span className="font-medium text-ink">{view.from}</span>.</>
              : "Not set up yet: no emails are sent."}{" "}
            One account serves every teacher on this server. A free Gmail account made for DragonGrader works well: turn on
            2-Step Verification, create an app password at myaccount.google.com/apppasswords, and paste it below.
          </p>
          {view.lastError && view.lastErrorAt !== null && (
            <Alert tone="danger" title="The last email couldn't be sent">
              {view.lastError} (<LocalTime ms={view.lastErrorAt} />)
            </Alert>
          )}
          {!view.lastError && view.lastSentAt !== null && (
            <p className="text-sm text-muted">Last email sent <LocalTime ms={view.lastSentAt} />.</p>
          )}
        </div>

        <form action={formAction} className="flex flex-col gap-4">
          {state && !state.ok && !fieldErrors && <Alert tone="danger">{state.error}</Alert>}
          {state?.ok && state.message && <Alert tone="success">{state.message}</Alert>}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Fill in for:</span>
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setHost(p.host);
                  setPort(String(p.port));
                  setSecurity(p.security);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field label="Mail server" htmlFor="smtp-host" error={fieldErrors?.host}>
              <Input id="smtp-host" name="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.gmail.com" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Port" htmlFor="smtp-port" error={fieldErrors?.port}>
              <Input id="smtp-port" name="port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="465" />
            </Field>
          </div>
          <Field label="Security" htmlFor="smtp-security" hint="Port 465 uses SSL/TLS; port 587 uses STARTTLS." error={fieldErrors?.security}>
            <Select id="smtp-security" name="security" value={security} onChange={(e) => setSecurity(e.target.value as typeof security)}>
              <option value="tls">SSL/TLS (port 465)</option>
              <option value="starttls">STARTTLS (port 587)</option>
              <option value="none">None (local mail server only)</option>
            </Select>
          </Field>
          <Field label="Username" htmlFor="smtp-user" hint="Usually the full email address." error={fieldErrors?.user}>
            <Input id="smtp-user" name="user" defaultValue={view.user} autoComplete="off" spellCheck={false} placeholder="dragongrader@gmail.com" />
          </Field>
          <Field
            label="Password"
            htmlFor="smtp-password"
            hint={view.hasPassword ? "Saved. Leave empty to keep it." : "For Gmail, the 16-letter app password. Stored encrypted."}
            error={fieldErrors?.password}
          >
            <Input id="smtp-password" name="password" type="password" autoComplete="new-password" />
          </Field>
          <Field label="From" htmlFor="smtp-from" hint="Leave empty to use the username." error={fieldErrors?.from}>
            <Input id="smtp-from" name="from" defaultValue={view.from} placeholder="DragonGrader <dragongrader@gmail.com>" autoComplete="off" />
          </Field>
          <Field
            label="DragonGrader's address, for links in emails"
            htmlFor="smtp-public-url"
            hint={`The address teachers open DragonGrader at, for example ${suggestedUrl}.${view.publicUrlFromEnv ? ` Empty: ${view.publicUrlFromEnv} (APP_URL).` : ""}`}
            error={fieldErrors?.publicUrl}
          >
            <Input id="smtp-public-url" name="publicUrl" defaultValue={view.publicUrl} placeholder={suggestedUrl} inputMode="url" autoComplete="off" spellCheck={false} />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingText="Saving…">Save</SubmitButton>
            {view.configured && (
              <Button
                variant="secondary"
                disabled={tester.pending}
                onClick={() => {
                  setTestMessage(null);
                  tester.run(() => sendTestEmailAction(), (r) => setTestMessage(r.message ?? "Sent."));
                }}
              >
                {tester.pending ? "Sending…" : `Send a test email to ${teacherEmail}`}
              </Button>
            )}
            {view.configured && (
              <Button
                variant="ghost"
                disabled={tester.pending}
                onClick={() => {
                  if (window.confirm("Turn off email for everyone on this server?")) tester.run(() => removeEmailSettingsAction());
                }}
              >
                Turn off email
              </Button>
            )}
          </div>
          {tester.error && <Alert tone="danger">{tester.error}</Alert>}
          {testMessage && <Alert tone="success">{testMessage}</Alert>}
        </form>
      </div>
    </div>
  );
}
