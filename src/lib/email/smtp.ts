import "server-only";
import nodemailer from "nodemailer";
import type { SmtpSecurity } from "@/lib/db/repos/email";

// Sending one email through the configured SMTP account. Tests replace the sender (setEmailSenderForTests).

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  password: string | null;
  from: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailSender = (config: SmtpConfig, email: OutgoingEmail) => Promise<void>;

const SLOT = Symbol.for("pag.email-sender");
const slots = globalThis as unknown as Record<symbol, EmailSender | undefined>;

export function setEmailSenderForTests(sender: EmailSender | undefined): void {
  slots[SLOT] = sender;
}

/** Sends `email`; rejects with an Error whose message says what went wrong (wrong password, server not answering…). */
export function sendEmail(config: SmtpConfig, email: OutgoingEmail): Promise<void> {
  return (slots[SLOT] ?? smtpSend)(config, email);
}

const smtpSend: EmailSender = async (config, email) => {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    auth: config.user ? { user: config.user, pass: config.password ?? "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({ from: config.from, to: email.to, subject: email.subject, text: email.text, html: email.html });
  } catch (e) {
    throw new Error(explainSmtpError(e));
  } finally {
    transport.close();
  }
};

/** A teacher-readable reason for a failed send. */
export function explainSmtpError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  if (err?.code === "EAUTH" || err?.responseCode === 535 || err?.responseCode === 534) {
    return "The mail server refused the username or password. For Gmail, use an app password (not your normal password).";
  }
  if (err?.code === "ECONNECTION" || err?.code === "ETIMEDOUT" || err?.code === "ESOCKET" || err?.code === "EDNS") {
    return `Couldn't reach the mail server (${err.code}). Check the server name, the port and the security setting.`;
  }
  if (err?.code === "EENVELOPE") return "The mail server refused the sender or the recipient address.";
  const message = (err?.message ?? String(e)).replace(/\s+/g, " ").trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message || "The email couldn't be sent.";
}
