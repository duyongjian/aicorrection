/**
 * better-sqlite3 连接 + 迁移（同步 API）
 * PRAGMA foreign_keys=ON 在运行时生效；WAL 提升并发读。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { runMigrations } from './migrate';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(env.DB_PATH), { recursive: true });
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  db = new Database(env.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export type { Database };
