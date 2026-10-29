import "server-only";
import * as z from "zod";
import { getConfig } from "@/lib/config";
import { getStoredEmailSettings, type SmtpSecurity } from "@/lib/db/repos/email";
import { decryptSecret } from "@/lib/secrets";
import type { SmtpConfig } from "./smtp";

// The outgoing mail account as the Settings form edits it, and as sending uses it.

export const SMTP_SECURITIES = ["tls", "starttls", "none"] as const satisfies readonly SmtpSecurity[];

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** "Name <a@b.c>" or "a@b.c". */
function isFromAddress(value: string): boolean {
  const named = /^[^<>]*<([^<>]+)>$/.exec(value);
  return ADDRESS.test(named ? named[1].trim() : value);
}

export const EmailSettingsSchema = z.object({
  host: z.string().trim().min(1, "Enter the mail server, for example smtp.gmail.com.").max(255)
    .refine((v) => HOST.test(v), "Enter just the server name, for example smtp.gmail.com (no http:// or spaces)."),
  port: z.coerce.number("Enter the port, usually 465 or 587.").int("Enter a whole number.").min(1, "Enter a port from 1 to 65535.")
    .max(65535, "Enter a port from 1 to 65535."),
  security: z.enum(SMTP_SECURITIES, "Choose how the connection is secured."),
  user: z.string().trim().max(255, "Use at most 255 characters."),
  /** Empty: keep the saved password. */
  password: z.string().max(500, "Use at most 500 characters."),
  from: z.string().trim().max(255, "Use at most 255 characters."),
  publicUrl: z.string().trim().max(500, "Use at most 500 characters.")
    .refine((v) => v === "" || (URL.canParse(v) && /^https?:$/.test(new URL(v).protocol)), "Enter the full address, starting with http:// or https://."),
});
export type EmailSettingsInput = z.infer<typeof EmailSettingsSchema>;

/** The sender: what's typed, else the username when it is an address. Null when neither is an address. */
export function senderAddress(input: Pick<EmailSettingsInput, "from" | "user">): string | null {
  if (input.from !== "") return isFromAddress(input.from) ? input.from : null;
  return ADDRESS.test(input.user) ? `DragonGrader <${input.user}>` : null;
}

/** "https://grader.school.edu/" → "https://grader.school.edu". */
export function cleanPublicUrl(value: string): string | null {
  return value === "" ? null : value.replace(/\/+$/, "");
}

export interface EmailSettingsView {
  configured: boolean;
  host: string;
  port: number | null;
  security: SmtpSecurity;
  user: string;
  hasPassword: boolean;
  from: string;
  /** Where links in emails point: the saved address, else APP_URL, else null. */
  publicUrl: string;
  publicUrlFromEnv: string | null;
  lastSentAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export function getEmailSettingsView(): EmailSettingsView {
  const s = getStoredEmailSettings();
  return {
    configured: s.host !== null && s.from !== null,
    host: s.host ?? "",
    port: s.port,
    security: s.security ?? "tls",
    user: s.user ?? "",
    hasPassword: s.passwordCiphertext !== null,
    from: s.from ?? "",
    publicUrl: s.publicUrl ?? "",
    publicUrlFromEnv: getConfig().appUrl,
    lastSentAt: s.lastSentAt,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
  };
}

/** The account to send with, or null when email isn't set up (or the password can't be decrypted on this server). */
export function currentSmtpConfig(): SmtpConfig | null {
  const s = getStoredEmailSettings();
  if (!s.host || !s.port || !s.security || !s.from) return null;
  const password = s.passwordCiphertext ? decryptSecret(s.passwordCiphertext, "smtp-password") : null;
  if (s.passwordCiphertext && password === null) return null;
  return { host: s.host, port: s.port, security: s.security, user: s.user, password, from: s.from };
}

/** The address links in emails start with: Settings, else APP_URL; null when neither is set. */
export function publicBaseUrl(): string | null {
  const saved = getStoredEmailSettings().publicUrl;
  return saved ?? getConfig().appUrl?.replace(/\/+$/, "") ?? null;
}
