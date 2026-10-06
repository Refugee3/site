import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import { deleteAssignmentRow } from "@/lib/db/repos/assignments";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { listKeyItems } from "@/lib/db/repos/keys";
import { getSubmission, listItems, setItemOverride } from "@/lib/db/repos/submissions";
import { seedApprovedKey, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";
import type { DB } from "@/lib/db/connection";

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function count(db: DB, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("migrate", () => {
  it("creates the schema on a fresh database and records the version", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(tableNames(db)).toEqual([
      "answer_keys", "assignments", "jobs", "key_items", "sections", "sessions", "submission_items", "submissions", "teachers",
    ]);
    db.close();
  });

  it("is a no-op when re-run", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES ('t1', 'a@b.c', 'A', 'h', 1)").run();
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(count(db, "teachers")).toBe(1);
    db.close();
  });

  it("numbers migrations 1..n in order", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });
});

describe("schema constraints", () => {
  let db: DB;
  let assignmentId: string;
  let submissionId: string;

  beforeEach(() => {
    db = useTestDb();
    const teacher = seedTeacher();
    assignmentId = seedAssignment(teacher.id).id;
    seedApprovedKey(assignmentId, [{}]);
    submissionId = seedSubmission(assignmentId).id;
  });

  it.each([
    ["assignment status", "UPDATE assignments SET status = 'archived'"],
    ["grading mode", "UPDATE assignments SET grading_mode = 'curve'"],
    ["accuracy weight", "UPDATE assignments SET accuracy_weight = 101"],
    ["share code length", "UPDATE assignments SET share_code = 'ABC'"],
    ["key status", "UPDATE answer_keys SET status = 'done'"],
    ["answer type", "UPDATE key_items SET answer_type = 'essay'"],
    ["answer source", "UPDATE key_items SET answer_source = 'student'"],
    ["item points", "UPDATE key_items SET points_centi = 0"],
    ["partial credit flag", "UPDATE key_items SET partial_credit = 2"],
    ["submission status", "UPDATE submissions SET status = 'done'"],
    ["submission source", "UPDATE submissions SET source = 'robot'"],
    ["document match", "UPDATE submissions SET document_match = 'maybe'"],
    ["name confidence", "UPDATE submissions SET ai_name_confidence = 'certain'"],
    ["integer column type", "UPDATE submissions SET page_count = 'many'"],
    ["job kind", "UPDATE jobs SET kind = 'email'"],
  ])("rejects a bad %s", (_name, sql) => {
    enqueueJob({ kind: "grade_submission", targetId: submissionId, assignmentId, priority: 10, maxAttempts: 4 });
    expect(() => db.prepare(sql).run()).toThrow(/constraint|cannot store/i);
  });

  it.each([
    ["attempt", "'finished'"],
    ["correctness", "'mostly'"],
    ["legibility", "'messy'"],
    ["review_reason", "'because'"],
  ])("rejects a bad submission_items.%s", (column, value) => {
    const itemId = listKeyItems(assignmentId)[0].id;
    setItemOverride(submissionId, itemId, { overrideCenti: 50 });
    expect(() => db.prepare(`UPDATE submission_items SET ${column} = ${value}`).run()).toThrow(/constraint/i);
  });

  it("rejects double-quoted string literals", () => {
    expect(() => db.prepare(`UPDATE assignments SET status = "open"`).run()).toThrow();
  });
});

describe("cascades", () => {
  it("deleting an assignment removes its sections, key, items, submissions, judgments and jobs", () => {
    const db = useTestDb();
    const teacher = seedTeacher();
    const assignment = seedAssignment(teacher.id, { sections: [{ label: "Period 1", canonicalKey: "1" }] });
    const [item] = seedApprovedKey(assignment.id, [{}]);
    const submission = seedSubmission(assignment.id);
    setItemOverride(submission.id, item.id, { overrideCenti: 100 });
    enqueueJob({ kind: "grade_submission", targetId: submission.id, assignmentId: assignment.id, priority: 10, maxAttempts: 4 });
    const other = seedAssignment(teacher.id);

    deleteAssignmentRow(assignment.id);

    for (const table of ["sections", "answer_keys", "key_items", "submissions", "submission_items", "jobs"]) {
      expect(count(db, table), table).toBe(table === "answer_keys" ? 1 : 0);
    }
    expect(count(db, "assignments")).toBe(1);
    expect(db.prepare("SELECT assignment_id FROM answer_keys").get()).toEqual({ assignment_id: other.id });
  });

  it("deleting a key item removes its judgments and overrides but keeps the submission", () => {
    const db = useTestDb();
    const assignment = seedAssignment(seedTeacher().id);
    const [first, second] = seedApprovedKey(assignment.id, [{}, {}]);
    const submission = seedSubmission(assignment.id);
    setItemOverride(submission.id, first.id, { overrideCenti: 100 });
    setItemOverride(submission.id, second.id, { overrideCenti: 50 });

    db.prepare("DELETE FROM key_items WHERE id = ?").run(first.id);

    expect(listItems(submission.id).map((i) => i.itemId)).toEqual([second.id]);
    expect(getSubmission(submission.id)).not.toBeNull();
  });

  it("deleting a teacher removes their sessions and assignments", () => {
    const db = useTestDb();
    const teacher = seedTeacher();
    seedAssignment(teacher.id);
    db.prepare("INSERT INTO sessions (token_hash, teacher_id, created_at, expires_at) VALUES ('h', ?, 1, 2)").run(teacher.id);

    db.prepare("DELETE FROM teachers WHERE id = ?").run(teacher.id);

    expect(count(db, "sessions")).toBe(0);
    expect(count(db, "assignments")).toBe(0);
  });
});
