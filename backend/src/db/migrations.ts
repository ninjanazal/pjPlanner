import type Database from 'better-sqlite3';
// Old schema had owners.email NOT NULL UNIQUE, which DROP COLUMN cannot remove, so rebuild the table.
export function migrateOwners(db: Database.Database) {
  const names = () => (db.prepare('PRAGMA table_info(owners)').all() as { name: string }[]).map((c) => c.name);
  if (names().includes('email')) {
    // foreign_keys cannot be changed inside a transaction; with it ON, DROP TABLE would cascade-delete rows that reference owners.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS owners_new;
          CREATE TABLE owners_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT);
          INSERT INTO owners_new (id, name) SELECT id, name FROM owners;
          DROP TABLE owners;
          ALTER TABLE owners_new RENAME TO owners;
        `);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign key check failed after owners migration');
  }
  const have = names();
  for (const c of ['color', 'icon']) {
    if (!have.includes(c)) db.exec(`ALTER TABLE owners ADD COLUMN ${c} TEXT`);
  }
}

// SQLite cannot alter a CHECK constraint, so old todo/doing/done issues are rebuilt as open/closed.
export function migrateIssueStates(db: Database.Database) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'").get() as { sql: string } | undefined;
  if (!row || !row.sql.includes('todo')) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS issues_new;
        CREATE TABLE issues_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('epic','story','task','bug','subtask')),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
          owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
          module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO issues_new (id, type, title, description, parent_id, owner_id, module_id, state, created_at)
          SELECT id, type, title, description, parent_id, owner_id, module_id,
            CASE WHEN state = 'done' THEN 'closed' ELSE 'open' END,
            COALESCE(created_at, CURRENT_TIMESTAMP) FROM issues;
        DROP TABLE issues;
        ALTER TABLE issues_new RENAME TO issues;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign key check failed after issues migration');
}

// Subtask was removed: it becomes a task. A task left under a task, or a bug/story under a non-epic, moves up to the nearest valid parent.
export function migrateIssueTypes(db: Database.Database) {
  db.transaction(() => {
    db.exec("UPDATE issues SET type = 'task' WHERE type = 'subtask'");
    const bad = db.prepare(`SELECT c.id, p.parent_id AS up FROM issues c JOIN issues p ON p.id = c.parent_id
      WHERE (c.type = 'task' AND p.type = 'task') OR (c.type IN ('bug', 'story') AND p.type <> 'epic')`);
    const move = db.prepare('UPDATE issues SET parent_id = ? WHERE id = ?');
    for (let rows = bad.all() as { id: number; up: number | null }[]; rows.length; rows = bad.all() as { id: number; up: number | null }[]) {
      rows.forEach((r) => move.run(r.up, r.id));
    }
  })();
}

// Everything belongs to a project. A fresh database has none (users create their own); data from before projects
// existed is moved into one project named "My project".
// Added last because the rebuild migrations above recreate tables without project_id.
export function migrateProjects(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const tables = ['modules', 'owners', 'groups', 'issues', 'sprints'];
  for (const t of tables) {
    if (!(db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === 'project_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
    }
  }
  if (!tables.some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE project_id IS NULL`).get())) return;
  const existing = db.prepare('SELECT MIN(id) AS id FROM projects').get() as { id: number | null };
  const pid = existing.id ?? Number(db.prepare("INSERT INTO projects (name) VALUES ('My project')").run().lastInsertRowid);
  for (const t of tables) db.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id IS NULL`).run(pid);
}

// Issues gained the code_review and test_validation states. SQLite cannot alter a CHECK constraint, so a table that still has
// the two-state one is rebuilt from its own definition (every column it has by now is kept). Run after all columns exist;
// indexes die with the old table, so the caller creates them afterwards.
const OLD_STATE_CHECK = /CHECK\s*\(\s*state\s+IN\s*\(\s*'open'\s*,\s*'closed'\s*\)\s*\)/i;
export function migrateWorkflowStates(db: Database.Database) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'").get() as { sql: string } | undefined;
  if (!row || !OLD_STATE_CHECK.test(row.sql)) return;
  const sql = row.sql
    .replace(OLD_STATE_CHECK, "CHECK (state IN ('open','code_review','test_validation','closed'))")
    .replace(/^CREATE TABLE\s+"?issues"?/i, 'CREATE TABLE issues_new');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS issues_new; ${sql}; INSERT INTO issues_new SELECT * FROM issues; DROP TABLE issues; ALTER TABLE issues_new RENAME TO issues;`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign key check failed after workflow states migration');
}
