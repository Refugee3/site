import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { run } from "@/lib/db/sql";
import { getNotifyState, setNotifyByEmail } from "@/lib/db/repos/email";
import { updateKey } from "@/lib/db/repos/keys";
import { updateSubmission } from "@/lib/db/repos/submissions";
import { saveEmailSettings } from "@/lib/services/email";
import { seedApprovedKey, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";
import type { SubmissionStatus } from "@/lib/types";
import { checkAssignmentNotifications, dueEmails } from "./notify";
import { type OutgoingEmail, setEmailSenderForTests } from "./smtp";

let sent: OutgoingEmail[];
let failNext: string | null;

beforeEach(() => {
  useTestDb();
  sent = [];
  failNext = null;
  setEmailSenderForTests(async (_config, email) => {
    if (failNext) {
      const message = failNext;
      failNext = null;
      throw new Error(message);
    }
    sent.push(email);
  });
  setClockForTests(() => 1_000_000);
  saveEmailSettings({
    host: "smtp.example.com", port: "465", security: "tls", user: "", password: "", from: "grader@example.com",
    publicUrl: "https://grader.example.edu/",
  });
});

afterEach(() => setEmailSenderForTests(undefined));

function setUp() {
  const teacher = seedTeacher({ email: "prof@example.edu" });
  const assignment = seedAssignment(teacher.id, { title: "Unit 4 Quiz" });
  seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2" }]);
  // As migration 17 leaves an existing assignment: nothing reported yet.
  run("UPDATE assignments SET grading_notified_at = 0, key_notified_revision = 1 WHERE id = ?", assignment.id);
  const paper = (status: SubmissionStatus, o: { gradedAt?: number; score?: number } = {}) => {
    const s = seedSubmission(assignment.id, { status });
    if (o.score !== undefined) updateSubmission(s.id, { scoreEarnedCenti: o.score, scoreMaxCenti: 200 });
    if (o.gradedAt !== undefined) run("UPDATE submissions SET graded_at = ? WHERE id = ?", o.gradedAt, s.id);
    return s;
  };
  return { teacher, assignment, paper };
}

describe("emails when work is done", () => {
  it("emails the teacher once when every paper is graded, with the counts, the average and links", async () => {
    const { assignment, paper } = setUp();
    paper("graded", { gradedAt: 900_000, score: 200 });
    paper("needs_review", { gradedAt: 950_000, score: 100 });
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "prof@example.edu", subject: "Graded: Unit 4 Quiz (1 to check)" });
    expect(sent[0].text).toContain("2 papers in Unit 4 Quiz were graded.");
    expect(sent[0].text).toContain("Class average: 75%.");
    expect(sent[0].text).toContain(`https://grader.example.edu/teacher/assignments/${assignment.id}?filter=needs_review`);
    expect(sent[0].html).toContain("<b>Dragon</b>Grader");

    // Nothing new: no second email (also after a restart, since what was reported is stored).
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toHaveLength(1);
    expect(getNotifyState(assignment.id)?.gradingNotifiedAt).toBe(950_000);
  });

  it("waits while papers are still queued or grading", async () => {
    const { assignment, paper } = setUp();
    paper("graded", { gradedAt: 900_000, score: 200 });
    const busy = paper("grading");
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toEqual([]);
    updateSubmission(busy.id, { status: "graded", scoreEarnedCenti: 0, scoreMaxCenti: 200 });
    run("UPDATE submissions SET graded_at = 990000 WHERE id = ?", busy.id);
    await checkAssignmentNotifications(assignment.id);
    expect(sent.map((e) => e.subject)).toEqual(["Graded: Unit 4 Quiz"]);
    expect(sent[0].text).toContain("2 papers in Unit 4 Quiz were graded.");
  });

  it("reports only papers graded since the last email", async () => {
    const { assignment, paper } = setUp();
    paper("graded", { gradedAt: 900_000, score: 200 });
    await checkAssignmentNotifications(assignment.id);
    paper("graded", { gradedAt: 1_500_000, score: 200 });
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain("1 paper in Unit 4 Quiz was graded.");
  });

  it("sends nothing to a teacher who turned emails off, and doesn't save it up for later", async () => {
    const { teacher, assignment, paper } = setUp();
    setNotifyByEmail(teacher.id, false);
    paper("graded", { gradedAt: 900_000, score: 200 });
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toEqual([]);
    setNotifyByEmail(teacher.id, true);
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toEqual([]);
  });

  it("records a failed send for Settings and doesn't retry it", async () => {
    const { assignment, paper } = setUp();
    paper("graded", { gradedAt: 900_000, score: 200 });
    failNext = "The mail server refused the username or password.";
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toEqual([]);
    const { getStoredEmailSettings } = await import("@/lib/db/repos/email");
    expect(getStoredEmailSettings().lastError).toBe("The mail server refused the username or password.");
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toEqual([]);
  });

  it("emails when an answer key is read and waiting for approval, but not once it's approved", async () => {
    const { assignment } = setUp();
    updateKey(assignment.id, { revision: 2, approvedRevision: 1 });
    expect(dueEmails(assignment.id).map((e) => e.content.subject)).toEqual(["Answer key ready to check: Unit 4 Quiz"]);
    await checkAssignmentNotifications(assignment.id);
    expect(sent[0].text).toContain("The AI has read the answer key for Unit 4 Quiz (2 questions).");
    expect(sent[0].text).toContain(`https://grader.example.edu/teacher/assignments/${assignment.id}/key`);
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toHaveLength(1);

    updateKey(assignment.id, { revision: 3, approvedRevision: 3 });
    expect(dueEmails(assignment.id)).toEqual([]);
  });

  it("does nothing without email set up", async () => {
    const { assignment, paper } = setUp();
    run("UPDATE app_settings SET smtp_host = NULL, smtp_from = NULL");
    paper("graded", { gradedAt: 900_000, score: 200 });
    await checkAssignmentNotifications(assignment.id);
    expect(sent).toEqual([]);
  });
});
