import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SQLite 持久化（node:sqlite，无原生依赖）。
 * 只保存：方案公共参数、教学份额、恢复操作状态。
 * 绝不保存：原秘密、随机系数、恢复出的值。
 */

export interface SchemeRow {
  schemeId: string;
  version: number;
  prime: string;
  threshold: number;
  shareCount: number;
  mode: "random" | "demo";
  createdAt: string;
}

export interface ShareRow {
  schemeId: string;
  x: number;
  y: string;
}

export interface RecoveryRow {
  recoveryId: string;
  schemeId: string;
  status: "success" | "failed";
  usedX: string; // JSON 数组，如 "[1,3]"
  detail: string; // 失败原因或一致性说明，不含秘密值
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schemes (
        scheme_id   TEXT PRIMARY KEY,
        version     INTEGER NOT NULL,
        prime       TEXT NOT NULL,
        threshold   INTEGER NOT NULL,
        share_count INTEGER NOT NULL,
        mode        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shares (
        scheme_id TEXT NOT NULL REFERENCES schemes(scheme_id),
        x         INTEGER NOT NULL,
        y         TEXT NOT NULL,
        PRIMARY KEY (scheme_id, x)
      );
      CREATE TABLE IF NOT EXISTS recoveries (
        recovery_id TEXT PRIMARY KEY,
        scheme_id   TEXT NOT NULL,
        status      TEXT NOT NULL,
        used_x      TEXT NOT NULL,
        detail      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `);
  }

  /**
   * 原子写入方案与全部 n 个份额：任一失败整体回滚，
   * 不会留下少于 n 个却被标为成功的集合。
   */
  createSchemeWithShares(scheme: SchemeRow, shares: ShareRow[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO schemes (scheme_id, version, prime, threshold, share_count, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(scheme.schemeId, scheme.version, scheme.prime, scheme.threshold, scheme.shareCount, scheme.mode, scheme.createdAt);
      const stmt = this.db.prepare("INSERT INTO shares (scheme_id, x, y) VALUES (?, ?, ?)");
      for (const s of shares) {
        stmt.run(s.schemeId, s.x, s.y);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getScheme(schemeId: string): SchemeRow | null {
    const row = this.db.prepare("SELECT * FROM schemes WHERE scheme_id = ?").get(schemeId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      schemeId: row.scheme_id as string,
      version: row.version as number,
      prime: row.prime as string,
      threshold: row.threshold as number,
      shareCount: row.share_count as number,
      mode: row.mode as "random" | "demo",
      createdAt: row.created_at as string,
    };
  }

  listSchemes(): SchemeRow[] {
    const rows = this.db.prepare("SELECT * FROM schemes ORDER BY created_at").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      schemeId: row.scheme_id as string,
      version: row.version as number,
      prime: row.prime as string,
      threshold: row.threshold as number,
      shareCount: row.share_count as number,
      mode: row.mode as "random" | "demo",
      createdAt: row.created_at as string,
    }));
  }

  getShares(schemeId: string): ShareRow[] {
    const rows = this.db
      .prepare("SELECT scheme_id, x, y FROM shares WHERE scheme_id = ? ORDER BY x")
      .all(schemeId) as Record<string, unknown>[];
    return rows.map((row) => ({ schemeId: row.scheme_id as string, x: row.x as number, y: row.y as string }));
  }

  recordRecovery(recovery: RecoveryRow): void {
    this.db
      .prepare(
        "INSERT INTO recoveries (recovery_id, scheme_id, status, used_x, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(recovery.recoveryId, recovery.schemeId, recovery.status, recovery.usedX, recovery.detail, recovery.createdAt);
  }

  listRecoveries(schemeId: string): RecoveryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM recoveries WHERE scheme_id = ? ORDER BY created_at")
      .all(schemeId) as Record<string, unknown>[];
    return rows.map((row) => ({
      recoveryId: row.recovery_id as string,
      schemeId: row.scheme_id as string,
      status: row.status as "success" | "failed",
      usedX: row.used_x as string,
      detail: row.detail as string,
      createdAt: row.created_at as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function defaultDbPath(): string {
  return join(process.cwd(), "data", "shamir.db");
}
