import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStoredEmailSettings } from "@/lib/db/repos/email";
import { currentSmtpConfig, publicBaseUrl, senderAddress } from "@/lib/email/settings";
import { explainSmtpError, setEmailSenderForTests, type OutgoingEmail } from "@/lib/email/smtp";
import { AppError } from "@/lib/errors";
import { seedTeacher, useTestDb } from "@/test/helpers";
import { removeEmailSettings, saveEmailSettings, sendTestEmail } from "./email";

const GMAIL = {
  host: "smtp.gmail.com", port: "465", security: "tls", user: "dragongrader@gmail.com", password: "abcd efgh ijkl mnop", from: "",
  publicUrl: "http://192.168.1.25:3000/",
};

let sent: Array<{ email: OutgoingEmail; password: string | null }>;

beforeEach(() => {
  useTestDb();
  sent = [];
  setEmailSenderForTests(async (config, email) => {
    sent.push({ email, password: config.password });
  });
});

afterEach(() => setEmailSenderForTests(undefined));

function fieldErrorsOf(fn: () => void): Record<string, string[]> | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.extra.fieldErrors;
    throw e;
  }
  return undefined;
}

describe("email settings", () => {
  it("saves a Gmail account with the password encrypted, the username as sender and the link address cleaned", () => {
    saveEmailSettings(GMAIL);
    const stored = getStoredEmailSettings();
    expect(stored).toMatchObject({ host: "smtp.gmail.com", port: 465, security: "tls", from: "DragonGrader <dragongrader@gmail.com>", publicUrl: "http://192.168.1.25:3000" });
    expect(stored.passwordCiphertext).not.toContain("abcd");
    expect(currentSmtpConfig()).toMatchObject({ user: "dragongrader@gmail.com", password: "abcd efgh ijkl mnop" });
    expect(publicBaseUrl()).toBe("http://192.168.1.25:3000");
  });

  it("keeps the saved password when the field is left empty", () => {
    saveEmailSettings(GMAIL);
    saveEmailSettings({ ...GMAIL, password: "", from: "Room 12 Grader <dragongrader@gmail.com>" });
    expect(currentSmtpConfig()).toMatchObject({ password: "abcd efgh ijkl mnop", from: "Room 12 Grader <dragongrader@gmail.com>" });
  });

  it("explains what to fix", () => {
    expect(fieldErrorsOf(() => saveEmailSettings({ ...GMAIL, host: "https://smtp.gmail.com" }))?.host?.[0]).toMatch(/just the server name/);
    expect(fieldErrorsOf(() => saveEmailSettings({ ...GMAIL, port: "99999" }))?.port).toBeDefined();
    expect(fieldErrorsOf(() => saveEmailSettings({ ...GMAIL, user: "teacher", from: "" }))?.from?.[0]).toMatch(/address emails come from/);
    expect(fieldErrorsOf(() => saveEmailSettings({ ...GMAIL, password: "" }))?.password?.[0]).toMatch(/password/);
    expect(fieldErrorsOf(() => saveEmailSettings({ ...GMAIL, publicUrl: "grader.local" }))?.publicUrl).toBeDefined();
  });

  it("reads the sender from a name and address, or the username", () => {
    expect(senderAddress({ from: "Grader <g@school.edu>", user: "" })).toBe("Grader <g@school.edu>");
    expect(senderAddress({ from: "", user: "g@school.edu" })).toBe("DragonGrader <g@school.edu>");
    expect(senderAddress({ from: "", user: "g" })).toBeNull();
  });

  it("sends a test email to the teacher, and says why one couldn't be sent", async () => {
    const teacher = seedTeacher({ email: "prof@example.edu" });
    await expect(sendTestEmail(teacher)).rejects.toThrow("Save the email settings first.");
    saveEmailSettings(GMAIL);
    await sendTestEmail(teacher);
    expect(sent[0].email).toMatchObject({ to: "prof@example.edu", subject: "DragonGrader test email" });
    expect(getStoredEmailSettings().lastSentAt).not.toBeNull();

    setEmailSenderForTests(async () => {
      throw new Error(explainSmtpError({ code: "EAUTH", responseCode: 535 }));
    });
    await expect(sendTestEmail(teacher)).rejects.toThrow(/refused the username or password/);
    expect(getStoredEmailSettings().lastError).toMatch(/app password/);

    removeEmailSettings();
    expect(currentSmtpConfig()).toBeNull();
  });
});
