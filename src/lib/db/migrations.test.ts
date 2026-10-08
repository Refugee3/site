import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import { deleteAssignmentRow } from "@/lib/db/repos/assignments";
import { claimNextJob, enqueueJob } from "@/lib/db/repos/jobs";
import { listKeyItems } from "@/lib/db/repos/keys";
import { getAiModel, getGradingEngine } from "@/lib/db/repos/settings";
import { getSubmission, listItems, setItemOverride } from "@/lib/db/repos/submissions";
import { setDbForTests, type DB } from "@/lib/db/connection";
import { seedApprovedKey, seedAssignment, seedLesson, seedScan, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

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
      "answer_keys", "app_settings", "assignments", "jobs", "key_items", "lessons", "scans", "sections", "sessions",
      "submission_items", "submissions", "teachers",
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

  it("upgrades a version-1 database in place, keeping its rows", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0].sql);
    db.pragma("user_version = 1");
    db.prepare("INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES ('t1', 'a@b.c', 'A', 'h', 1)").run();
    db.prepare(`INSERT INTO assignments (id, teacher_id, title, share_code, created_at, updated_at)
                VALUES ('a1', 't1', 'Quiz', 'ABCDEF', 1, 1)`).run();

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT ai_usage_json FROM assignments WHERE id = 'a1'").get()).toEqual({ ai_usage_json: "{}" });
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns("submission_items")).toContain("override_what_student_did");
    expect(columns("submissions")).toContain("client_upload_id");
    db.close();
  });
});

describe("migration 3 on a version-2 database", () => {
  const JOB_COLUMNS = "id, kind, target_id, assignment_id, status, priority, attempts, max_attempts, run_after, max_tokens, last_error, "
    + "created_at, updated_at, finished_at";

  /** A v2 database (built with the shipped v1 and v2 SQL) holding a graded paper, a judgment and jobs in every state. */
  function versionTwoDatabase(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATIONS[0].sql);
    db.exec(MIGRATIONS[1].sql);
    db.pragma("user_version = 2");
    db.exec(`
      INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES ('t1', 'a@b.c', 'A', 'h', 1);
      INSERT INTO assignments (id, teacher_id, title, share_code, created_at, updated_at) VALUES ('a1', 't1', 'Quiz', 'ABCDEF', 1, 1);
      INSERT INTO answer_keys (assignment_id, status, revision, approved_revision, updated_at) VALUES ('a1', 'ready', 1, 1, 1);
      INSERT INTO key_items (id, assignment_id, position, label, answer_type, points_centi, partial_credit, answer_source)
        VALUES ('i1', 'a1', 0, '1', 'short_answer', 100, 1, 'teacher');
      INSERT INTO submissions (id, assignment_id, source, receipt_token, pdf_path, original_filename, content_sha256, byte_size,
        page_count, status, graded_key_revision, created_at, updated_at)
        VALUES ('s1', 'a1', 'teacher', 'r1', 'p', 'f.pdf', 'sha', 1, 1, 'graded', 1, 1, 1);
      INSERT INTO submission_items (submission_id, item_id, attempt, correctness, legibility, confidence, review_reason, updated_at)
        VALUES ('s1', 'i1', 'complete', 'correct', 'clear', 'high', 'none', 1);
      INSERT INTO jobs (id, kind, target_id, assignment_id, status, priority, attempts, max_attempts, run_after, max_tokens, last_error,
        created_at, updated_at, finished_at) VALUES
        (3, 'extract_key', 'a1', 'a1', 'done', 0, 1, 4, 1, NULL, NULL, 1, 2, 2),
        (7, 'grade_submission', 's1', 'a1', 'running', 10, 2, 4, 5, 128000, 'overloaded', 3, 4, NULL),
        (9, 'grade_submission', 's1', 'a1', 'queued', 15, 0, 4, 6, NULL, NULL, 5, 5, NULL);
    `);
    return db;
  }

  it("keeps every job with its id, unpaused, and keeps the other rows", () => {
    const db = versionTwoDatabase();
    const before = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY id`).all();

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY id`).all()).toEqual(before);
    expect(db.prepare("SELECT id, paused FROM jobs ORDER BY id").all()).toEqual([
      { id: 3, paused: 0 }, { id: 7, paused: 0 }, { id: 9, paused: 0 },
    ]);
    expect(db.prepare("SELECT status, graded_guidance_fp FROM submissions").get()).toEqual({ status: "graded", graded_guidance_fp: null });
    expect(count(db, "submission_items")).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("adds the settings row with student uploads off, and empty grading preferences", () => {
    const db = versionTwoDatabase();
    migrate(db);

    expect(db.prepare("SELECT * FROM app_settings").all()).toEqual([{
      id: 1, students_can_upload: 0, api_key_ciphertext: null, api_key_masked: null, api_key_check: null,
      api_key_set_by: null, api_key_set_at: null, updated_at: 0,
      grading_engine: null, agent_install_id: expect.stringMatching(/^[0-9a-f]{12}$/), agent_key_fp: null,
      agent_environment_json: null, agent_agents_json: null, agent_status: "none", agent_error: null, agent_checked_at: null,
      ai_model: "claude-sonnet-5-5",
    }]);
    expect(db.prepare("SELECT grading_preferences FROM teachers").get()).toEqual({ grading_preferences: "" });
    expect(() => db.prepare("UPDATE teachers SET grading_preferences = ?").run("x".repeat(4001))).toThrow(/constraint/i);
    db.prepare("UPDATE teachers SET grading_preferences = ?").run("x".repeat(4000));
    db.close();
  });

  it("accepts split_scan jobs, rejects unknown kinds, and keeps the one-queued-job upsert and the claim order", () => {
    const db = versionTwoDatabase();
    migrate(db);
    setDbForTests(db);

    enqueueJob({ kind: "split_scan", targetId: "scan-1", assignmentId: "a1", priority: 5, maxAttempts: 4 });
    enqueueJob({ kind: "grade_submission", targetId: "s1", assignmentId: "a1", priority: 12, maxAttempts: 4, runAfter: 1 });
    expect(() => db.prepare(`INSERT INTO jobs (kind, target_id, assignment_id, status, priority, max_attempts, run_after, created_at,
      updated_at) VALUES ('email', 'x', 'a1', 'queued', 0, 1, 0, 0, 0)`).run()).toThrow(/constraint/i);

    expect(db.prepare("SELECT id, priority, run_after FROM jobs WHERE kind = 'grade_submission' AND status = 'queued'").all())
      .toEqual([{ id: 9, priority: 12, run_after: 1 }]);
    expect(claimNextJob(Date.now())).toMatchObject({ kind: "split_scan", targetId: "scan-1", paused: false });
  });

  it("drops jobs whose assignment no longer exists, so the rebuilt table passes foreign_key_check", () => {
    const db = versionTwoDatabase();
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO jobs (id, kind, target_id, assignment_id, status, priority, max_attempts, run_after, created_at, updated_at)
                VALUES (20, 'grade_submission', 'gone', 'missing', 'queued', 10, 4, 0, 0, 0)`).run();
    db.pragma("foreign_keys = ON");

    migrate(db);

    expect(db.prepare("SELECT id FROM jobs ORDER BY id").all()).toEqual([{ id: 3 }, { id: 7 }, { id: 9 }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("still cascades from assignments to jobs, and a second migrate is a no-op", () => {
    const db = versionTwoDatabase();
    migrate(db);
    const schema = db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(count(db, "app_settings")).toBe(1);
    db.prepare("DELETE FROM assignments WHERE id = 'a1'").run();
    expect(count(db, "jobs")).toBe(0);
    db.close();
  });
});

describe("migration 4 on a version-3 database", () => {
  /** A v3 database (built with the shipped v1–v3 SQL) with a saved key, uploads on and a graded paper. */
  function versionThreeDatabase(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 3)) db.exec(migration.sql);
    db.pragma("user_version = 3");
    db.exec(`
      INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES ('t1', 'a@b.c', 'A', 'h', 1);
      INSERT INTO assignments (id, teacher_id, title, share_code, created_at, updated_at) VALUES ('a1', 't1', 'Quiz', 'ABCDEF', 1, 1);
      INSERT INTO submissions (id, assignment_id, source, receipt_token, pdf_path, original_filename, content_sha256, byte_size,
        page_count, status, ai_model, created_at, updated_at)
        VALUES ('s1', 'a1', 'teacher', 'r1', 'p', 'f.pdf', 'sha', 1, 1, 'graded', 'claude-opus-5-5', 1, 1);
      UPDATE app_settings SET students_can_upload = 1, api_key_ciphertext = 'v1.iv.tag.ct', api_key_masked = 'sk-ant-…a1b2',
        api_key_check = 'verified', api_key_set_by = 't1', api_key_set_at = 7, updated_at = 7 WHERE id = 1;
    `);
    return db;
  }

  it("keeps the settings and papers, and adds the hosted-agent columns with their defaults", () => {
    const db = versionThreeDatabase();
    const submission = db.prepare("SELECT * FROM submissions").get() as Record<string, unknown>;

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT * FROM app_settings").all()).toEqual([{
      id: 1, students_can_upload: 1, api_key_ciphertext: "v1.iv.tag.ct", api_key_masked: "sk-ant-…a1b2", api_key_check: "verified",
      api_key_set_by: "t1", api_key_set_at: 7, updated_at: 7,
      grading_engine: null, agent_install_id: expect.stringMatching(/^[0-9a-f]{12}$/), agent_key_fp: null,
      agent_environment_json: null, agent_agents_json: null, agent_status: "none", agent_error: null, agent_checked_at: null,
      ai_model: "claude-sonnet-5-5",
    }]);
    // Migration 6 adds the timing columns: queued_at starts as the upload time.
    expect(db.prepare("SELECT * FROM submissions").get()).toEqual({ ...submission, ai_engine: null, grading_started_at: null, queued_at: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("gives each install its own id", () => {
    const ids = [versionThreeDatabase(), versionThreeDatabase()].map((db) => {
      migrate(db);
      const { agent_install_id: id } = db.prepare("SELECT agent_install_id FROM app_settings").get() as { agent_install_id: string };
      db.close();
      return id;
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([
    ["grading engine", "UPDATE app_settings SET grading_engine = 'x'"],
    ["agent status", "UPDATE app_settings SET agent_status = 'provisioning'"],
    ["missing agent status", "UPDATE app_settings SET agent_status = NULL"],
    ["long agent error", `UPDATE app_settings SET agent_error = '${"e".repeat(501)}'`],
    ["install id length", "UPDATE app_settings SET agent_install_id = 'abc'"],
    ["key fingerprint length", `UPDATE app_settings SET agent_key_fp = '${"f".repeat(31)}'`],
    ["paper engine", "UPDATE submissions SET ai_engine = 'x'"],
  ])("rejects a bad %s", (_name, sql) => {
    const db = versionThreeDatabase();
    migrate(db);
    expect(() => db.prepare(sql).run()).toThrow(/constraint/i);
    db.close();
  });

  it("accepts every allowed value", () => {
    const db = versionThreeDatabase();
    migrate(db);
    for (const engine of ["agent", "direct", null]) db.prepare("UPDATE app_settings SET grading_engine = ?").run(engine);
    for (const status of ["none", "ready", "error"]) db.prepare("UPDATE app_settings SET agent_status = ?").run(status);
    for (const engine of ["direct", "agent", "fake", null]) db.prepare("UPDATE submissions SET ai_engine = ?").run(engine);
    db.prepare("UPDATE app_settings SET agent_error = ?, agent_key_fp = ?, agent_install_id = NULL")
      .run("e".repeat(500), "f".repeat(32));

    expect(db.prepare("SELECT grading_engine, agent_status, length(agent_error) AS error_length, agent_install_id FROM app_settings").get())
      .toEqual({ grading_engine: null, agent_status: "error", error_length: 500, agent_install_id: null });
    expect(db.prepare("SELECT ai_engine FROM submissions").get()).toEqual({ ai_engine: null });
    db.close();
  });

  it("is a no-op when re-run, keeping the install id", () => {
    const db = versionThreeDatabase();
    migrate(db);
    const schema = db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
    const settings = db.prepare("SELECT * FROM app_settings").all();

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(db.prepare("SELECT * FROM app_settings").all()).toEqual(settings);
    db.close();
  });
});

describe("migration 5 on a version-4 database", () => {
  const AGENTS_JSON = JSON.stringify({
    extract: { id: "agent_x", version: 1, hash: "hx" }, grade: { id: "agent_g", version: 1, hash: "hg" },
    scan: { id: "agent_s", version: 1, hash: "hs" },
  });

  /** A v4 database (built with the shipped v1–v4 SQL) with a saved key, a hosted agent set up and a graded paper. */
  function versionFourDatabase(engine: "agent" | "direct" | null): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration.sql);
    db.pragma("user_version = 4");
    db.exec(`
      INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES ('t1', 'a@b.c', 'A', 'h', 1);
      INSERT INTO assignments (id, teacher_id, title, share_code, created_at, updated_at) VALUES ('a1', 't1', 'Quiz', 'ABCDEF', 1, 1);
      INSERT INTO submissions (id, assignment_id, source, receipt_token, pdf_path, original_filename, content_sha256, byte_size,
        page_count, status, ai_model, ai_engine, graded_key_revision, created_at, updated_at)
        VALUES ('s1', 'a1', 'teacher', 'r1', 'p', 'f.pdf', 'sha', 1, 1, 'graded', 'claude-opus-5-5', 'agent', 1, 1, 1);
      UPDATE app_settings SET students_can_upload = 1, api_key_ciphertext = 'v1.iv.tag.ct', api_key_masked = 'sk-ant-…a1b2',
        api_key_check = 'verified', api_key_set_by = 't1', api_key_set_at = 7, updated_at = 7,
        agent_key_fp = '${"f".repeat(32)}', agent_environment_json = '{"id":"env_1","hash":"he"}',
        agent_agents_json = '${AGENTS_JSON}', agent_status = 'ready', agent_checked_at = 5 WHERE id = 1;
    `);
    db.prepare("UPDATE app_settings SET grading_engine = ? WHERE id = 1").run(engine);
    return db;
  }

  it("adds the AI model as Sonnet 5.5 and keeps every other setting and paper as it was", () => {
    const db = versionFourDatabase(null);
    const settings = db.prepare("SELECT * FROM app_settings").get() as Record<string, unknown>;
    const submission = db.prepare("SELECT * FROM submissions").get() as Record<string, unknown>;

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT * FROM app_settings").get()).toEqual({ ...settings, ai_model: "claude-sonnet-5-5" });
    // The papers keep the model and engine they were graded with (migration 6 only adds its timing columns).
    expect(db.prepare("SELECT * FROM submissions").get()).toEqual({ ...submission, grading_started_at: null, queued_at: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it.each([
    ["agent", "agent"],
    ["direct", "direct"],
    // Never chosen: v4 meant the hosted agent; the direct API is the default now.
    [null, "direct"],
  ] as const)("keeps a stored grading engine of %j, which resolves to %j", (engine, effective) => {
    const db = versionFourDatabase(engine);
    migrate(db);
    expect(db.prepare("SELECT grading_engine, ai_model FROM app_settings").get())
      .toEqual({ grading_engine: engine, ai_model: "claude-sonnet-5-5" });
    setDbForTests(db);
    expect(getGradingEngine()).toBe(effective);
    expect(getAiModel()).toBe("claude-sonnet-5-5");
  });

  it("accepts the two models and rejects anything else, including no model", () => {
    const db = versionFourDatabase(null);
    migrate(db);
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) db.prepare("UPDATE app_settings SET ai_model = ?").run(model);
    for (const model of ["claude-opus-5", "claude-sonnet-5", "", null]) {
      expect(() => db.prepare("UPDATE app_settings SET ai_model = ?").run(model), String(model)).toThrow(/constraint/i);
    }
    expect(db.prepare("SELECT ai_model FROM app_settings").get()).toEqual({ ai_model: "claude-sonnet-5-5" });
    db.close();
  });

  it("is a no-op when re-run, keeping a model chosen since", () => {
    const db = versionFourDatabase("agent");
    migrate(db);
    db.prepare("UPDATE app_settings SET ai_model = 'claude-opus-5-5'").run();
    const schema = db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();

    migrate(db);

    expect(db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(db.prepare("SELECT grading_engine, ai_model FROM app_settings").get())
      .toEqual({ grading_engine: "agent", ai_model: "claude-opus-5-5" });
    db.close();
  });
});

describe("migration 6 on a version-5 database", () => {
  /** A v5 database with a batch being graded, a key being read and a scan being split. */
  function versionFiveDatabase(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 5)) db.exec(migration.sql);
    db.pragma("user_version = 5");
    db.exec(`
      INSERT INTO teachers (id, email, display_name, password_hash, created_at) VALUES ('t1', 'a@b.c', 'A', 'h', 1);
      INSERT INTO assignments (id, teacher_id, title, share_code, created_at, updated_at) VALUES ('a1', 't1', 'Quiz', 'ABCDEF', 1, 1);
      INSERT INTO assignments (id, teacher_id, title, share_code, created_at, updated_at) VALUES ('a2', 't1', 'Idle', 'GHJKLM', 1, 1);
      INSERT INTO answer_keys (assignment_id, status, updated_at) VALUES ('a1', 'processing', 40), ('a2', 'ready', 41);
      INSERT INTO submissions (id, assignment_id, source, receipt_token, pdf_path, original_filename, content_sha256, byte_size,
        page_count, status, created_at, updated_at) VALUES
        ('s1', 'a1', 'teacher', 'r1', 'p', 'f.pdf', 'sha1', 1, 1, 'graded', 10, 10),
        ('s2', 'a1', 'teacher', 'r2', 'p', 'f.pdf', 'sha2', 1, 1, 'grading', 20, 20),
        ('s3', 'a1', 'teacher', 'r3', 'p', 'f.pdf', 'sha3', 1, 1, 'queued', 30, 30),
        ('s4', 'a2', 'teacher', 'r4', 'p', 'f.pdf', 'sha4', 1, 1, 'graded', 5, 5);
      INSERT INTO scans (id, assignment_id, status, split_mode, pdf_path, original_filename, content_sha256, byte_size, page_count,
        created_at, updated_at) VALUES
        ('c1', 'a1', 'splitting', 'auto', 'p', 's.pdf', 'shac1', 1, 4, 50, 55),
        ('c2', 'a1', 'review', 'auto', 'p', 's.pdf', 'shac2', 1, 4, 60, 65);
    `);
    return db;
  }

  it("adds the timing columns, starts the batch of papers already waiting, and the clocks of work in progress", () => {
    const db = versionFiveDatabase();
    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT id, queued_at, grading_started_at FROM submissions ORDER BY id").all()).toEqual([
      { id: "s1", queued_at: 10, grading_started_at: null }, { id: "s2", queued_at: 20, grading_started_at: null },
      { id: "s3", queued_at: 30, grading_started_at: null }, { id: "s4", queued_at: 5, grading_started_at: null },
    ]);
    expect(db.prepare("SELECT id, batch_started_at FROM assignments ORDER BY id").all()).toEqual([
      { id: "a1", batch_started_at: 20 }, { id: "a2", batch_started_at: null },
    ]);
    expect(db.prepare("SELECT assignment_id, processing_started_at, processing_finished_at FROM answer_keys ORDER BY assignment_id").all())
      .toEqual([
        { assignment_id: "a1", processing_started_at: 40, processing_finished_at: null },
        { assignment_id: "a2", processing_started_at: null, processing_finished_at: null },
      ]);
    expect(db.prepare("SELECT id, split_started_at, split_finished_at, auto_graded FROM scans ORDER BY id").all()).toEqual([
      { id: "c1", split_started_at: 50, split_finished_at: null, auto_graded: 0 },
      { id: "c2", split_started_at: null, split_finished_at: null, auto_graded: 0 },
    ]);
    expect(() => db.prepare("UPDATE scans SET auto_graded = 2").run()).toThrow(/constraint/i);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("is a no-op when re-run", () => {
    const db = versionFiveDatabase();
    migrate(db);
    const schema = db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
    migrate(db);
    expect(db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    db.close();
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
    ["job paused flag", "UPDATE jobs SET paused = 2"],
    ["second settings row", "INSERT INTO app_settings (id, updated_at) VALUES (2, 0)"],
    ["students_can_upload flag", "UPDATE app_settings SET students_can_upload = 2"],
    ["API key check", "UPDATE app_settings SET api_key_ciphertext = 'c', api_key_masked = 'm', api_key_check = 'maybe'"],
    ["API key without its mask", "UPDATE app_settings SET api_key_ciphertext = 'c', api_key_check = 'verified'"],
    ["API key without its check", "UPDATE app_settings SET api_key_ciphertext = 'c', api_key_masked = 'm'"],
    ["mask without a key", "UPDATE app_settings SET api_key_masked = 'm'"],
    ["long API key mask", `UPDATE app_settings SET api_key_ciphertext = 'c', api_key_masked = '${"m".repeat(41)}', api_key_check = 'verified'`],
    ["long grading preferences", `UPDATE teachers SET grading_preferences = '${"p".repeat(4001)}'`],
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

  it.each([
    ["AI attempt without correctness", "UPDATE lessons SET ai_correctness = NULL"],
    ["teacher correctness without attempt", "UPDATE lessons SET teacher_attempt = NULL"],
    ["teacher attempt", "UPDATE lessons SET teacher_attempt = 'most'"],
    ["AI correctness", "UPDATE lessons SET ai_correctness = 'mostly'"],
    ["active flag", "UPDATE lessons SET active = 2"],
    ["negative override", "UPDATE lessons SET override_centi = -1"],
    ["long reason", `UPDATE lessons SET reason = '${"r".repeat(1001)}'`],
    ["long student answer", `UPDATE lessons SET student_answer = '${"a".repeat(2001)}'`],
    ["long feedback", `UPDATE lessons SET feedback = '${"f".repeat(2001)}'`],
    ["long \"what you did\"", `UPDATE lessons SET what_student_did = '${"w".repeat(1001)}'`],
  ])("rejects a lesson with a bad %s", (_name, sql) => {
    seedLesson({ assignmentId, submissionId, itemId: listKeyItems(assignmentId)[0].id });
    expect(() => db.prepare(sql).run()).toThrow(/constraint/i);
  });

  it("allows one lesson per paper and item", () => {
    const itemId = listKeyItems(assignmentId)[0].id;
    seedLesson({ assignmentId, submissionId, itemId });
    expect(() => db.prepare(`INSERT INTO lessons (id, assignment_id, item_id, submission_id, created_at, updated_at)
      VALUES ('l2', ?, ?, ?, 0, 0)`).run(assignmentId, itemId, submissionId)).toThrow(/UNIQUE/);
  });

  it.each([
    ["status", "UPDATE scans SET status = 'queued'"],
    ["split mode", "UPDATE scans SET split_mode = 'manual'"],
    ["pages per paper", "UPDATE scans SET pages_per_paper = 101"],
    ["zero pages per paper", "UPDATE scans SET pages_per_paper = 0"],
    ["page count", "UPDATE scans SET page_count = 0"],
  ])("rejects a scan with a bad %s", async (_name, sql) => {
    await seedScan(assignmentId, { writeFile: false });
    expect(() => db.prepare(sql).run()).toThrow(/constraint/i);
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

  it("deleting an assignment removes its lessons and scans", async () => {
    const db = useTestDb();
    const assignment = seedAssignment(seedTeacher().id);
    const [item] = seedApprovedKey(assignment.id, [{}]);
    seedLesson({ assignmentId: assignment.id, submissionId: seedSubmission(assignment.id).id, itemId: item.id });
    await seedScan(assignment.id, { writeFile: false });

    deleteAssignmentRow(assignment.id);

    expect(count(db, "lessons")).toBe(0);
    expect(count(db, "scans")).toBe(0);
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
