import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only: never edit a migration that has shipped; add a new one instead. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE teachers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  instructions TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  grading_mode TEXT NOT NULL DEFAULT 'completion' CHECK (grading_mode IN ('completion','accuracy','blended')),
  accuracy_weight INTEGER NOT NULL DEFAULT 50 CHECK (accuracy_weight BETWEEN 0 AND 100),
  share_code TEXT NOT NULL UNIQUE CHECK (length(share_code) = 6),
  max_submissions INTEGER NOT NULL DEFAULT 500 CHECK (max_submissions BETWEEN 1 AND 5000),
  feedback_released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX assignments_teacher ON assignments(teacher_id, created_at);

CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  canonical_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE (assignment_id, canonical_key)
) STRICT;

CREATE TABLE answer_keys (
  assignment_id TEXT PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('empty','processing','ready','failed')),
  source_pdf_path TEXT, source_filename TEXT, source_sha256 TEXT, source_page_count INTEGER,
  document_kind TEXT,
  teacher_notes TEXT NOT NULL DEFAULT '' CHECK (length(teacher_notes) <= 4000),
  ai_notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  approved_revision INTEGER,
  fingerprint TEXT,
  error_message TEXT,
  ai_model TEXT,
  usage_json TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE key_items (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES answer_keys(assignment_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  group_label TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  answer_type TEXT NOT NULL CHECK (answer_type IN ('multiple_choice','true_false','numeric','short_answer','long_answer','fill_in_blank','matching','diagram','other')),
  expected_answer TEXT NOT NULL DEFAULT '',
  acceptable_answers_json TEXT NOT NULL DEFAULT '[]',
  grading_criteria TEXT NOT NULL DEFAULT '',
  points_centi INTEGER NOT NULL CHECK (points_centi BETWEEN 1 AND 100000),
  partial_credit INTEGER NOT NULL CHECK (partial_credit IN (0,1)),
  page INTEGER,
  answer_source TEXT NOT NULL CHECK (answer_source IN ('key','ai_proposed','teacher')),
  ai_confidence TEXT CHECK (ai_confidence IN ('high','medium','low')),
  ai_note TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX key_items_order ON key_items(assignment_id, position);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('student','teacher')),
  receipt_token TEXT NOT NULL UNIQUE,
  pdf_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','grading','graded','needs_review','failed')),
  status_note TEXT,
  grading_generation INTEGER NOT NULL DEFAULT 1,
  graded_key_revision INTEGER,
  ai_name TEXT,
  ai_name_confidence TEXT CHECK (ai_name_confidence IN ('high','medium','low')),
  ai_section_raw TEXT,
  ai_section_match TEXT,
  student_name TEXT CHECK (student_name IS NULL OR length(student_name) <= 120),
  name_source TEXT CHECK (name_source IN ('ai','teacher')),
  name_key TEXT,
  name_sort_key TEXT NOT NULL DEFAULT '~',
  section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
  section_key TEXT,
  section_source TEXT CHECK (section_source IN ('ai','teacher')),
  document_match TEXT CHECK (document_match IN ('matches','uncertain','different_assignment','not_student_work','blank')),
  flags_json TEXT NOT NULL DEFAULT '[]',
  overall_feedback TEXT NOT NULL DEFAULT '',
  overall_feedback_edited INTEGER NOT NULL DEFAULT 0 CHECK (overall_feedback_edited IN (0,1)),
  teacher_summary TEXT NOT NULL DEFAULT '',
  integrity_note TEXT NOT NULL DEFAULT '',
  unmatched_work TEXT NOT NULL DEFAULT '',
  total_override_centi INTEGER CHECK (total_override_centi IS NULL OR total_override_centi >= 0),
  score_earned_centi INTEGER, score_max_centi INTEGER, completion_centi INTEGER, accuracy_centi INTEGER,
  ai_model TEXT, usage_json TEXT, ai_output_json TEXT,
  error_code TEXT, error_message TEXT,
  graded_at INTEGER, reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assignment_id, content_sha256)
) STRICT;
CREATE INDEX submissions_board ON submissions(assignment_id, section_id, name_sort_key, created_at);
CREATE INDEX submissions_status ON submissions(assignment_id, status);

CREATE TABLE submission_items (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES key_items(id) ON DELETE CASCADE,
  attempt TEXT CHECK (attempt IN ('complete','partial','none')),
  correctness TEXT CHECK (correctness IN ('correct','minor_error','partially_correct','major_error','incorrect','no_answer','cannot_judge')),
  legibility TEXT CHECK (legibility IN ('clear','partly_illegible','illegible','no_writing')),
  confidence TEXT CHECK (confidence IN ('high','medium','low')),
  review_reason TEXT CHECK (review_reason IN ('none','alternate_answer','key_may_be_wrong','multiple_answers','ambiguous_reading','other')),
  student_answer TEXT NOT NULL DEFAULT '',
  pages_json TEXT NOT NULL DEFAULT '[]',
  what_student_did TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  teacher_note TEXT NOT NULL DEFAULT '',
  override_centi INTEGER CHECK (override_centi IS NULL OR override_centi >= 0),
  override_feedback TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (submission_id, item_id)
) STRICT;

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('extract_key','grade_submission')),
  target_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  priority INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_after INTEGER NOT NULL,
  max_tokens INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX jobs_one_queued ON jobs(kind, target_id) WHERE status = 'queued';
CREATE INDEX jobs_claim ON jobs(status, priority, run_after, id);
`,
  },
  {
    version: 2,
    name: "usage_ledger_overrides_upload_ids",
    sql: `
-- Every AI call's usage, added up per served model: {"<model>": {calls, inputTokens, ...}}.
ALTER TABLE assignments ADD COLUMN ai_usage_json TEXT NOT NULL DEFAULT '{}';
-- The teacher's version of the student-facing "what you did" note; survives regrades like override_feedback.
ALTER TABLE submission_items ADD COLUMN override_what_student_did TEXT;
-- The id the student's browser sent with the upload, so only a retry of the same upload replays its receipt.
ALTER TABLE submissions ADD COLUMN client_upload_id TEXT;
`,
  },
  {
    version: 3,
    name: "settings_lessons_scans",
    sql: `
-- App-wide settings: exactly one row. Student uploads start OFF, for existing databases too.
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  students_can_upload INTEGER NOT NULL DEFAULT 0 CHECK (students_can_upload IN (0,1)),
  api_key_ciphertext TEXT,                               -- encryptSecret(key, "anthropic-api-key")
  api_key_masked TEXT CHECK (api_key_masked IS NULL OR length(api_key_masked) <= 40),  -- "sk-ant-…a1b2"
  api_key_check TEXT CHECK (api_key_check IN ('verified','unverified')),
  api_key_set_by TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  api_key_set_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((api_key_ciphertext IS NULL) = (api_key_masked IS NULL)),
  CHECK ((api_key_ciphertext IS NULL) = (api_key_check IS NULL))
) STRICT;
INSERT INTO app_settings (id, students_can_upload, updated_at) VALUES (1, 0, 0);

-- Teacher-level grading preferences (all of the teacher's assignments).
ALTER TABLE teachers ADD COLUMN grading_preferences TEXT NOT NULL DEFAULT '' CHECK (length(grading_preferences) <= 4000);

-- The guidance a grading was sent: guidanceFingerprint(rendered guidance); '' = none; NULL = graded before v3 or never (≡ '').
ALTER TABLE submissions ADD COLUMN graded_guidance_fp TEXT;

-- Lessons: one per (submission, item); snapshots taken when the teacher saves a correction.
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES key_items(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,   -- kept when the paper is deleted
  student_answer TEXT NOT NULL DEFAULT '' CHECK (length(student_answer) <= 2000),
  ai_attempt TEXT CHECK (ai_attempt IN ('complete','partial','none')),
  ai_correctness TEXT CHECK (ai_correctness IN ('correct','minor_error','partially_correct','major_error','incorrect','no_answer','cannot_judge')),
  teacher_attempt TEXT CHECK (teacher_attempt IN ('complete','partial','none')),
  teacher_correctness TEXT CHECK (teacher_correctness IN ('correct','minor_error','partially_correct','major_error','incorrect','no_answer','cannot_judge')),
  override_centi INTEGER CHECK (override_centi IS NULL OR override_centi >= 0),
  feedback TEXT CHECK (feedback IS NULL OR length(feedback) <= 2000),
  what_student_did TEXT CHECK (what_student_did IS NULL OR length(what_student_did) <= 1000),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((ai_attempt IS NULL) = (ai_correctness IS NULL)),
  CHECK ((teacher_attempt IS NULL) = (teacher_correctness IS NULL)),
  UNIQUE (submission_id, item_id)
) STRICT;
CREATE INDEX lessons_assignment ON lessons(assignment_id, updated_at);
CREATE INDEX lessons_item ON lessons(item_id);

-- Whole-stack scans.
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('splitting','review','creating','done','failed')),
  split_mode TEXT NOT NULL CHECK (split_mode IN ('auto','every')),
  pages_per_paper INTEGER CHECK (pages_per_paper IS NULL OR pages_per_paper BETWEEN 1 AND 100),
  split_generation INTEGER NOT NULL DEFAULT 1,             -- bumped by "every N"/"try the AI again"; guards AI writes
  pdf_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count >= 1),
  readings_json TEXT NOT NULL DEFAULT '[]',                -- Array<ScanPageReading | null>, length page_count once reading starts
  pages_read INTEGER NOT NULL DEFAULT 0,
  layout_json TEXT,                                        -- ScanLayout the teacher grades (null while splitting/failed)
  proposed_layout_json TEXT,                               -- the original proposal ("Reset")
  status_note TEXT,
  error_message TEXT,
  ai_model TEXT,
  usage_json TEXT,                                         -- AiUsage summed over chunk calls
  created_count INTEGER,
  duplicate_count INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX scans_assignment ON scans(assignment_id, created_at);
CREATE INDEX scans_sha ON scans(assignment_id, content_sha256);

-- New job kind 'split_scan' + jobs.paused: rebuild (SQLite cannot alter a CHECK). Safe with foreign_keys=ON
-- inside migrate()'s transaction because no table references jobs, so DROP TABLE runs no foreign-key actions.
CREATE TABLE jobs_v3 (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('extract_key','grade_submission','split_scan')),
  target_id TEXT NOT NULL,                                 -- assignment_id | submission_id | scan_id
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  priority INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_after INTEGER NOT NULL,
  max_tokens INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1))  -- 1 = run_after was pushed out by a worker pause
) STRICT;
INSERT INTO jobs_v3 (id, kind, target_id, assignment_id, status, priority, attempts, max_attempts, run_after, max_tokens,
                     last_error, created_at, updated_at, finished_at)
  SELECT id, kind, target_id, assignment_id, status, priority, attempts, max_attempts, run_after, max_tokens,
         last_error, created_at, updated_at, finished_at
  FROM jobs WHERE assignment_id IN (SELECT id FROM assignments);
DROP TABLE jobs;
ALTER TABLE jobs_v3 RENAME TO jobs;
CREATE UNIQUE INDEX jobs_one_queued ON jobs(kind, target_id) WHERE status = 'queued';
CREATE INDEX jobs_claim ON jobs(status, priority, run_after, id);
`,
  },
  {
    version: 4,
    name: "grading_engine_hosted_agent",
    sql: `
-- Grading engine: NULL = the default (the Anthropic-hosted agent); 'direct' = the Messages API path.
ALTER TABLE app_settings ADD COLUMN grading_engine TEXT CHECK (grading_engine IN ('agent','direct'));
-- Names this install's environment ("pdf-autograder-<id>"); environment names are unique per workspace.
ALTER TABLE app_settings ADD COLUMN agent_install_id TEXT CHECK (agent_install_id IS NULL OR length(agent_install_id) = 12);
UPDATE app_settings SET agent_install_id = lower(hex(randomblob(6))) WHERE id = 1;
-- The hosted agent's remote objects, all owned by the API key with this fingerprint (apiKeyFingerprint()).
ALTER TABLE app_settings ADD COLUMN agent_key_fp TEXT CHECK (agent_key_fp IS NULL OR length(agent_key_fp) = 32);
ALTER TABLE app_settings ADD COLUMN agent_environment_json TEXT;   -- {"id": "env_…", "hash": "<sha256 hex>"}
ALTER TABLE app_settings ADD COLUMN agent_agents_json TEXT;        -- {"extract"|"grade"|"scan": {"id", "version", "hash"}}
ALTER TABLE app_settings ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'none' CHECK (agent_status IN ('none','ready','error'));
ALTER TABLE app_settings ADD COLUMN agent_error TEXT CHECK (agent_error IS NULL OR length(agent_error) <= 500);
ALTER TABLE app_settings ADD COLUMN agent_checked_at INTEGER;      -- ms; last setup that succeeded or failed
-- Which engine produced the stored grading (review page note); NULL = graded before v4 or never.
ALTER TABLE submissions ADD COLUMN ai_engine TEXT CHECK (ai_engine IN ('direct','agent','fake'));
`,
  },
  {
    version: 5,
    name: "ai_model_choice",
    sql: `
-- Settings → AI model: the model that reads answer keys and grades papers (both engines). Existing servers start on
-- Sonnet 5.5 like new ones; ANTHROPIC_MODEL is no longer read. Splitting scans always uses Sonnet 5.5.
ALTER TABLE app_settings ADD COLUMN ai_model TEXT NOT NULL DEFAULT 'claude-sonnet-5-5'
  CHECK (ai_model IN ('claude-sonnet-5-5','claude-opus-5-5'));
-- grading_engine keeps its values; NULL (never chosen) now means the direct API, which the code resolves.
`,
  },
  {
    version: 6,
    name: "timings_batches_auto_grade",
    sql: `
-- Progress and time estimates (all ms). A paper's grading time is graded_at - grading_started_at.
ALTER TABLE submissions ADD COLUMN grading_started_at INTEGER;     -- set when status -> grading; cleared when put back in the queue
ALTER TABLE submissions ADD COLUMN queued_at INTEGER;              -- when it was last queued (upload or regrade): batch membership
UPDATE submissions SET queued_at = created_at;
CREATE INDEX submissions_graded ON submissions(assignment_id, graded_at);
CREATE INDEX submissions_graded_at ON submissions(graded_at);
-- The current grading batch: set when a paper is queued while none of the assignment's papers is queued or grading,
-- cleared when they are all done. Papers queued since then make up the batch.
ALTER TABLE assignments ADD COLUMN batch_started_at INTEGER;
UPDATE assignments SET batch_started_at = (SELECT min(s.queued_at) FROM submissions s
  WHERE s.assignment_id = assignments.id AND s.status IN ('queued', 'grading'));
-- Answer-key reading: when the key went to processing, and when the AI's reading was stored.
ALTER TABLE answer_keys ADD COLUMN processing_started_at INTEGER;
ALTER TABLE answer_keys ADD COLUMN processing_finished_at INTEGER;
UPDATE answer_keys SET processing_started_at = updated_at WHERE status = 'processing';
-- Whole-class scans: when the AI split was queued and when it finished; auto_graded = papers were created without the teacher
-- because the AI's split had nothing to check.
ALTER TABLE scans ADD COLUMN split_started_at INTEGER;
ALTER TABLE scans ADD COLUMN split_finished_at INTEGER;
ALTER TABLE scans ADD COLUMN auto_graded INTEGER NOT NULL DEFAULT 0 CHECK (auto_graded IN (0,1));
UPDATE scans SET split_started_at = created_at WHERE status = 'splitting';
`,
  },
  {
    version: 7,
    name: "assignment_kind",
    sql: `
-- Homework or quiz: graded the same way; only labels and the dashboard filter differ.
ALTER TABLE assignments ADD COLUMN kind TEXT NOT NULL DEFAULT 'homework' CHECK (kind IN ('homework','quiz'));
`,
  },
  {
    version: 8,
    name: "assignment_write_notes",
    sql: `
-- Whether the AI writes notes for students ("What you did", feedback, overall feedback) and for the teacher. Off for new
-- and existing assignments: notes are most of the AI's writing, so papers cost less without them.
ALTER TABLE assignments ADD COLUMN write_notes INTEGER NOT NULL DEFAULT 0 CHECK (write_notes IN (0,1));
`,
  },
];

/** Applies every migration newer than `PRAGMA user_version`, all in one transaction. */
export function migrate(db: Database): void {
  db.transaction(() => {
    const current = db.pragma("user_version", { simple: true }) as number;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
  }).immediate();
}
