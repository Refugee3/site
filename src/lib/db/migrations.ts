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
