import "server-only";
import { now } from "@/lib/clock";
import {
  clearStoredEmailSettings, getStoredEmailSettings, recordEmailError, recordEmailSent, saveStoredEmailSettings, setNotifyByEmail,
} from "@/lib/db/repos/email";
import { testEmail } from "@/lib/email/messages";
import { cleanPublicUrl, currentSmtpConfig, EmailSettingsSchema, publicBaseUrl, senderAddress } from "@/lib/email/settings";
import { sendEmail } from "@/lib/email/smtp";
import { AppError } from "@/lib/errors";
import { parseInput } from "@/lib/http/validation";
import { encryptSecret } from "@/lib/secrets";
import type { Teacher } from "@/lib/types";

/** Settings → Email: saves the outgoing mail account. An empty password keeps the saved one. */
export function saveEmailSettings(input: unknown): void {
  const s = parseInput(EmailSettingsSchema, input);
  const from = senderAddress(s);
  if (from === null) {
    throw new AppError("validation", "Some fields need fixing.", {
      fieldErrors: { from: ["Enter the address emails come from, for example DragonGrader <grader@gmail.com>."] },
    });
  }
  const stored = getStoredEmailSettings();
  if (s.user !== "" && s.password === "" && stored.passwordCiphertext === null) {
    throw new AppError("validation", "Some fields need fixing.", { fieldErrors: { password: ["Enter the password for this account."] } });
  }
  saveStoredEmailSettings({
    host: s.host.toLowerCase(),
    port: s.port,
    security: s.security,
    user: s.user === "" ? null : s.user,
    // No username: no password either. Else a typed password replaces the saved one; empty keeps it.
    passwordCiphertext: s.user === "" ? null : s.password === "" ? undefined : encryptSecret(s.password, "smtp-password"),
    from,
    publicUrl: cleanPublicUrl(s.publicUrl),
  });
}

export function removeEmailSettings(): void {
  clearStoredEmailSettings();
}

/** Sends a test email to the teacher with the saved account; throws AppError with the reason when it fails. */
export async function sendTestEmail(teacher: Teacher): Promise<void> {
  const smtp = currentSmtpConfig();
  if (!smtp) throw new AppError("invalid_state", "Save the email settings first.");
  try {
    await sendEmail(smtp, { to: teacher.email, ...testEmail(publicBaseUrl()) });
    recordEmailSent(now());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordEmailError(message, now());
    throw new AppError("invalid_state", `The test email couldn't be sent: ${message}`);
  }
}

export function setTeacherEmailNotifications(teacher: Teacher, on: boolean): void {
  setNotifyByEmail(teacher.id, on);
}
