import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDataDir(): string {
  return process.env.ACME_PROJECTS_DATA_DIR ?? join(projectRoot, "data");
}

export function openDatabase(dataDir = resolveDataDir()): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "projects.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repository_path TEXT NOT NULL DEFAULT '',
      issues_url TEXT NOT NULL DEFAULT '',
      issues_project_ref TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '',
      open_questions TEXT NOT NULL DEFAULT '',
      acceptance_notes TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL DEFAULT 'ideas'
        CHECK(column_id IN ('ideas', 'exploring', 'ready', 'in_progress', 'in_review', 'done')),
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS card_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      author TEXT NOT NULL DEFAULT 'You',
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cards_board
      ON cards(project_id, column_id, position);
    CREATE INDEX IF NOT EXISTS idx_card_comments
      ON card_comments(card_id, created_at);

    CREATE TABLE IF NOT EXISTS implementation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      issues_url TEXT NOT NULL,
      issues_project_ref TEXT NOT NULL DEFAULT '',
      trigger_label TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('issue_pending', 'withdrawn')),
      snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_implementation_attempts_card
      ON implementation_attempts(card_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_implementation_attempts_active
      ON implementation_attempts(card_id)
      WHERE status = 'issue_pending';
  `);

  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColumns.some((column) => column.name === "repository_path")) {
    db.exec("ALTER TABLE projects ADD COLUMN repository_path TEXT NOT NULL DEFAULT ''");
  }
  if (!projectColumns.some((column) => column.name === "issues_url")) {
    db.exec("ALTER TABLE projects ADD COLUMN issues_url TEXT NOT NULL DEFAULT ''");
  }
  if (!projectColumns.some((column) => column.name === "issues_project_ref")) {
    db.exec("ALTER TABLE projects ADD COLUMN issues_project_ref TEXT NOT NULL DEFAULT ''");
  }

  const attemptColumns = db.prepare("PRAGMA table_info(implementation_attempts)").all() as { name: string }[];
  if (!attemptColumns.some((column) => column.name === "trigger_label")) {
    db.exec("ALTER TABLE implementation_attempts ADD COLUMN trigger_label TEXT NOT NULL DEFAULT 'trigger'");
  }
  if (!attemptColumns.some((column) => column.name === "issues_project_ref")) {
    db.exec("ALTER TABLE implementation_attempts ADD COLUMN issues_project_ref TEXT NOT NULL DEFAULT ''");
  }
}
