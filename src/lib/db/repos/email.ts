import { now } from "@/lib/clock";
import { one, run } from "@/lib/db/sql";

// The outgoing mail account (SMTP) in the settings row, each teacher's "email me" choice, and what was already emailed
// about each assignment (migration 17).

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface StoredEmailSettings {
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  user: string | null;
  passwordCiphertext: string | null;
  from: string | null;
  publicUrl: string | null;
  lastSentAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

interface EmailRow {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: SmtpSecurity | null;
  smtp_user: string | null;
  smtp_password_ciphertext: string | null;
  smtp_from: string | null;
  public_url: string | null;
  email_last_sent_at: number | null;
  email_last_error: string | null;
  email_last_error_at: number | null;
}

export function getStoredEmailSettings(): StoredEmailSettings {
  const row = one<EmailRow>(
    `SELECT smtp_host, smtp_port, smtp_security, smtp_user, smtp_password_ciphertext, smtp_from, public_url,
       email_last_sent_at, email_last_error, email_last_error_at FROM app_settings WHERE id = 1`,
  )!;
  return {
    host: row.smtp_host,
    port: row.smtp_port,
    security: row.smtp_security,
    user: row.smtp_user,
    passwordCiphertext: row.smtp_password_ciphertext,
    from: row.smtp_from,
    publicUrl: row.public_url,
    lastSentAt: row.email_last_sent_at,
    lastError: row.email_last_error,
    lastErrorAt: row.email_last_error_at,
  };
}

/** Saves the account; `passwordCiphertext` undefined keeps the stored password. Clears the last error. */
export function saveStoredEmailSettings(s: {
  host: string; port: number; security: SmtpSecurity; user: string | null; passwordCiphertext?: string | null; from: string;
  publicUrl: string | null;
}): void {
  const keep = s.passwordCiphertext === undefined;
  run(
    `UPDATE app_settings SET smtp_host = @host, smtp_port = @port, smtp_security = @security, smtp_user = @user,
       smtp_password_ciphertext = CASE WHEN @keep = 1 THEN smtp_password_ciphertext ELSE @password END,
       smtp_from = @from, public_url = @public_url, email_last_error = NULL, email_last_error_at = NULL, updated_at = @at
     WHERE id = 1`,
    {
      host: s.host, port: s.port, security: s.security, user: s.user, keep: keep ? 1 : 0, password: keep ? null : s.passwordCiphertext ?? null,
      from: s.from, public_url: s.publicUrl, at: now(),
    },
  );
}

export function clearStoredEmailSettings(): void {
  run(
    `UPDATE app_settings SET smtp_host = NULL, smtp_port = NULL, smtp_security = NULL, smtp_user = NULL,
       smtp_password_ciphertext = NULL, smtp_from = NULL, email_last_error = NULL, email_last_error_at = NULL, updated_at = ?
     WHERE id = 1`,
    now(),
  );
}

export function recordEmailSent(at: number): void {
  run("UPDATE app_settings SET email_last_sent_at = ?, email_last_error = NULL, email_last_error_at = NULL WHERE id = 1", at);
}

export function recordEmailError(message: string, at: number): void {
  run("UPDATE app_settings SET email_last_error = ?, email_last_error_at = ? WHERE id = 1", message.slice(0, 500), at);
}

export function getNotifyByEmail(teacherId: string): boolean {
  return one<{ notify_by_email: number }>("SELECT notify_by_email FROM teachers WHERE id = ?", teacherId)?.notify_by_email === 1;
}

export function setNotifyByEmail(teacherId: string, on: boolean): void {
  run("UPDATE teachers SET notify_by_email = ? WHERE id = ?", on ? 1 : 0, teacherId);
}

export interface NotifyState {
  /** Papers graded up to this time (ms) were reported (null: none yet). */
  gradingNotifiedAt: number | null;
  /** The key revision a "ready to check" email went out for (null: none). */
  keyNotifiedRevision: number | null;
}

export function getNotifyState(assignmentId: string): NotifyState | null {
  const row = one<{ grading_notified_at: number | null; key_notified_revision: number | null }>(
    "SELECT grading_notified_at, key_notified_revision FROM assignments WHERE id = ?",
    assignmentId,
  );
  return row ? { gradingNotifiedAt: row.grading_notified_at, keyNotifiedRevision: row.key_notified_revision } : null;
}

export function setGradingNotifiedAt(assignmentId: string, at: number): void {
  run("UPDATE assignments SET grading_notified_at = ? WHERE id = ?", at, assignmentId);
}

export function setKeyNotifiedRevision(assignmentId: string, revision: number): void {
  run("UPDATE assignments SET key_notified_revision = ? WHERE id = ?", revision, assignmentId);
}

/** Every assignment id (for the check after a restart). */
export function listAssignmentIds(): string[] {
  return (one<{ ids: string | null }>("SELECT group_concat(id, ',') AS ids FROM assignments")?.ids ?? "").split(",").filter(Boolean);
}
