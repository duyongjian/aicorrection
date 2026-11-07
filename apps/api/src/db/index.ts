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
  // 线下分发 / 隔离测试库覆盖：未设置时完全沿用 env.DB_PATH，既有行为零变化。
  // 设置 AICORRECTION_DB_PATH 后，API 与发卡 CLI 共用同一独立库，
  // 确保分发版不会读写既有 335MB 生产库。每次 getDb() 读取，配合
  // __resetDbSingleton() 可在同一进程内切换测试库。
  const dbPath = process.env.AICORRECTION_DB_PATH?.trim() || env.DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/**
 * 测试 / 诊断用：关闭并清空单例，使下次 getDb() 按当前 env.DB_PATH 重新打开。
 * 生产代码不应调用；env.DB_PATH 在导入时已快照，切换测试库需同时修改 env.DB_PATH。
 */
export function __resetDbSingleton(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

export type { Database };
