// SQLite 持久化层。
// 只保存：方案公共参数、教学份额（横坐标/纵坐标）、恢复操作状态。
// 默认不保存：原秘密、随机系数、恢复出的值。
// 固定演示样本可通过显式导出文件另存。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Share } from '../core/shamir.js';
import { SCHEME_VERSION } from '../core/shamir.js';

export interface SchemeRecord {
  id: string;
  version: string;
  threshold: number;
  shareCount: number;
  demo: number;
  createdAt: string;
}

export interface RecoveryRecord {
  id: string;
  schemeId: string;
  status: 'success' | 'rejected';
  reasonCode: string | null;
  selectedX: string | null;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schemes (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        share_count INTEGER NOT NULL,
        demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheme_id TEXT NOT NULL REFERENCES schemes(id),
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        UNIQUE(scheme_id, x)
      );
      CREATE TABLE IF NOT EXISTS recoveries (
        id TEXT PRIMARY KEY,
        scheme_id TEXT NOT NULL REFERENCES schemes(id),
        status TEXT NOT NULL,
        reason_code TEXT,
        selected_x TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * 原子保存一次份额生成：方案与全部 n 个份额在同一事务内提交，
   * 任何失败都整体回滚，不会留下少于 n 个却标为成功的集合。
   */
  saveSchemeAndShares(rec: SchemeRecord, shares: Share[]): void {
    if (shares.length !== rec.shareCount) {
      throw new Error(
        `原子性断言失败：应保存 ${rec.shareCount} 个份额，实际 ${shares.length} 个`
      );
    }
    const insertScheme = this.db.prepare(
      `INSERT INTO schemes (id, version, threshold, share_count, demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertShare = this.db.prepare(
      'INSERT INTO shares (scheme_id, x, y) VALUES (?, ?, ?)'
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      insertScheme.run(
        rec.id,
 rec.version,
        rec.threshold,
        rec.shareCount,
        rec.demo,
        rec.createdAt
      );
      for (const s of shares) insertShare.run(rec.id, s.x, s.y);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getScheme(id: string): SchemeRecord | null {
    const row = this.db
      .prepare('SELECT * FROM schemes WHERE id = ?')
      .get(id) as
      | {
          id: string;
          version: string;
          threshold: number;
          share_count: number;
          demo: number;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      threshold: row.threshold,
      shareCount: row.share_count,
      demo: row.demo,
      createdAt: row.created_at,
    };
  }

  getShares(schemeId: string): Share[] {
    const rows = this.db
      .prepare('SELECT x, y FROM shares WHERE scheme_id = ? ORDER BY x ASC')
      .all(schemeId) as { x: number; y: number }[];
    const scheme = this.getScheme(schemeId);
    return rows.map((r) => ({
      schemeId,
      version: scheme?.version ?? SCHEME_VERSION,
      threshold: scheme?.threshold ?? 0,
      x: r.x,
      y: r.y,
    }));
  }

  recordRecovery(rec: RecoveryRecord): void {
    this.db
      .prepare(
        `INSERT INTO recoveries (id, scheme_id, status, reason_code, selected_x, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.schemeId,
        rec.status,
        rec.reasonCode,
        rec.selectedX,
        rec.createdAt
      );
  }

  listRecoveries(schemeId: string): RecoveryRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM recoveries WHERE scheme_id = ? ORDER BY rowid DESC'
      )
      .all(schemeId) as {
      id: string;
      scheme_id: string;
      status: string;
      reason_code: string | null;
      selected_x: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      schemeId: r.scheme_id,
      status: r.status as RecoveryRecord['status'],
      reasonCode: r.reason_code,
      selectedX: r.selected_x,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
