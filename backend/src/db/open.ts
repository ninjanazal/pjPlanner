import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { migrateOwners, migrateIssueStates, migrateIssueTypes, migrateProjects, migrateWorkflowStates } from './migrations.js';
const hasColumn = (db: Database.Database, table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT
    );
    CREATE TABLE IF NOT EXISTS module_owners (
      module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      PRIMARY KEY (module_id, owner_id)
    );
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      label TEXT,
      UNIQUE (source_id, target_id),
      CHECK (source_id <> target_id)
    );
  `);
  migrateOwners(db);
  const relCols = db.prepare('PRAGMA table_info(relations)').all() as { name: string }[];
  if (!relCols.some((x) => x.name === 'color')) db.exec('ALTER TABLE relations ADD COLUMN color TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT)');
  const groupCols = db.prepare('PRAGMA table_info(groups)').all() as { name: string }[];
  if (!groupCols.some((x) => x.name === 'parent_id')) {
    db.exec('ALTER TABLE groups ADD COLUMN parent_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL');
  }
  const cols = db.prepare('PRAGMA table_info(modules)').all() as { name: string }[];
  if (!cols.some((x) => x.name === 'group_id')) {
    db.exec('ALTER TABLE modules ADD COLUMN group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL');
  }
  for (const c of ['color', 'icon']) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE modules ADD COLUMN ${c} TEXT NULL`);
  }
  for (const c of ['x', 'y']) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE modules ADD COLUMN ${c} REAL NULL`);
  }
  for (const c of ['text_color', 'stroke_color']) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE modules ADD COLUMN ${c} TEXT`);
  }
  if (!cols.some((x) => x.name === 'stroke_style')) {
    db.exec(`ALTER TABLE modules ADD COLUMN stroke_style TEXT NOT NULL DEFAULT 'solid'`);
  }
  if (!cols.some((x) => x.name === 'test_status')) db.exec('ALTER TABLE modules ADD COLUMN test_status TEXT NULL');
  if (!cols.some((x) => x.name === 'test_notes')) db.exec(`ALTER TABLE modules ADD COLUMN test_notes TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_api_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('function','endpoint','event','type','other')),
      name TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('epic','story','task','bug','subtask')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
      module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','code_review','test_validation','closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'module_id')) {
    db.exec('ALTER TABLE issues ADD COLUMN module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL');
  }
  migrateIssueStates(db);
  migrateIssueTypes(db);
  db.exec("UPDATE issues SET owner_id = NULL, module_id = NULL WHERE type <> 'task'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','active','closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Sprints no longer have dates (opened and closed by hand); drop them from databases created earlier.
  for (const c of ['start_date', 'end_date']) {
    if ((db.prepare('PRAGMA table_info(sprints)').all() as { name: string }[]).some((x) => x.name === c)) db.exec(`ALTER TABLE sprints DROP COLUMN ${c}`);
  }
  // Added after migrateIssueStates, which rebuilds the table without it.
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'sprint_id')) {
    db.exec('ALTER TABLE issues ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL');
  }
  // Effort of a task in whole steps (null = 1); the sprint timeline plans with it.
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'estimate')) {
    db.exec('ALTER TABLE issues ADD COLUMN estimate INTEGER');
  }
  // How-to notes for whoever picks a task up (approach, pitfalls, links); tasks only.
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'implementation')) {
    db.exec("ALTER TABLE issues ADD COLUMN implementation TEXT NOT NULL DEFAULT ''");
  }
  // Timing history, kept on the row: when a task first went into review, when it was last closed (and by whom),
  // how often it was reopened and when it last changed. All UTC 'YYYY-MM-DD HH:MM:SS'; null = unknown (older rows, Jira imports).
  const issueCols = (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name);
  for (const [col, ddl] of [['started_at', 'TEXT'], ['closed_at', 'TEXT'], ['closed_owner_id', 'INTEGER'], ['reopen_count', 'INTEGER NOT NULL DEFAULT 0'], ['updated_at', 'TEXT']]) {
    if (!issueCols.includes(col)) db.exec(`ALTER TABLE issues ADD COLUMN ${col} ${ddl}`);
  }
  db.exec("UPDATE issues SET sprint_id = NULL WHERE type <> 'task' AND sprint_id IS NOT NULL"); // epics and bugs are never in a sprint
  migrateProjects(db);
  // Jira: the JQL and label a project tracks, and the Jira key an imported issue came from.
  if (!hasColumn(db, 'projects', 'jira_jql')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_jql TEXT');
  }
  if (!hasColumn(db, 'projects', 'jira_label')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_label TEXT');
  }
  if (!hasColumn(db, 'projects', 'jira_synced_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_synced_at TEXT');
  }
  if (!hasColumn(db, 'projects', 'jira_write')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_write INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'projects', 'jira_project_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_project_id TEXT');
  }
  if (!hasColumn(db, 'projects', 'jira_upload_config')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_upload_config TEXT');
  }
  // Per-project Jira switch. Projects that already track a filter keep working, so they start enabled.
  if (!hasColumn(db, 'projects', 'jira_enabled')) {
    db.exec('ALTER TABLE projects ADD COLUMN jira_enabled INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE projects SET jira_enabled = 1 WHERE (jira_jql IS NOT NULL AND jira_jql <> '') OR (jira_label IS NOT NULL AND jira_label <> '')");
  }
  if (!hasColumn(db, 'issues', 'jira_key')) {
    db.exec('ALTER TABLE issues ADD COLUMN jira_key TEXT');
  }
  if (!hasColumn(db, 'issues', 'jira_synced_at')) {
    db.exec('ALTER TABLE issues ADD COLUMN jira_synced_at TEXT'); // Jira's `updated` right after our own last write; never exported
  }
  migrateWorkflowStates(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS issues_jira_key ON issues (project_id, jira_key) WHERE jira_key IS NOT NULL');
  return db;
}
