/**
 * 迁移运行器：按文件名顺序执行 migrations/*.sql，幂等（_migrations 表记录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );
  const dir = path.resolve(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = db
    .prepare('SELECT name FROM _migrations')
    .all() as Array<{ name: string }>;
  const existing = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (existing.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied ${file}`);
  }
}
