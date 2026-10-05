import { randomUUID } from "node:crypto";
import { FIELD_PRIME } from "./field.js";
import { AppError, ErrorCodes } from "./errors.js";
import {
  Share,
  InterpolationTrace,
  generateShares,
  interpolateAtZero,
  evaluateInterpolated,
  validateParams,
  validateSecret,
  MAX_SHARES,
} from "./shamir.js";
import { Store, SchemeRow } from "./store.js";

export const PARAM_VERSION = 1;

export interface ShareEnvelope {
  schemeId: string;
  version: number;
  prime: string;
  threshold: number;
  x: number;
  y: string;
}

export interface RecoveryResult {
  recoveryId: string;
  schemeId: string;
  secret: string;
  trace: InterpolationTrace;
  /** 多余份额的一致性核对结果 */
  consistency: { checkedX: number[]; ok: true } | { checkedX: number[]; ok: false; conflicts: number[] };
}

export class ShamirService {
  constructor(private store: Store) {}

  /** 建立分享方案：随机模式用系统随机源，演示模式注入固定系数。 */
  createScheme(opts: {
    secret: string;
    threshold: number;
    shareCount: number;
    demoCoefficients?: string[];
  }): { scheme: SchemeRow; shares: ShareEnvelope[]; coefficients?: string[] } {
    const { threshold, shareCount } = opts;
    try {
      validateParams(threshold, shareCount);
    } catch (err) {
      throw new AppError(ErrorCodes.INVALID_PARAMS, (err as Error).message);
    }

    let secret: bigint;
    try {
      secret = BigInt(opts.secret);
    } catch {
      throw new AppError(ErrorCodes.INVALID_SECRET, `秘密必须是十进制整数，收到：${opts.secret}`);
    }
    try {
      validateSecret(secret);
    } catch (err) {
      throw new AppError(ErrorCodes.INVALID_SECRET, (err as Error).message);
    }

    const demo = opts.demoCoefficients !== undefined;
    let demoCoeffs: bigint[] | undefined;
    if (demo) {
      try {
        demoCoeffs = opts.demoCoefficients!.map((c) => BigInt(c));
      } catch {
        throw new AppError(ErrorCodes.INVALID_PARAMS, "演示系数必须是十进制整数数组");
      }
    }

    let shares: Share[];
    let coefficients: string[];
    try {
      ({ shares, coefficients } = generateShares(secret, threshold, shareCount, demoCoeffs));
    } catch (err) {
      throw new AppError(ErrorCodes.INVALID_PARAMS, (err as Error).message);
    }

    const schemeId = randomUUID();
    const scheme: SchemeRow = {
      schemeId,
      version: PARAM_VERSION,
      prime: FIELD_PRIME.toString(),
      threshold,
      shareCount,
      mode: demo ? "demo" : "random",
      createdAt: new Date().toISOString(),
    };
    // 原子保存：方案 + 全部 n 个份额，同事务提交。
    this.store.createSchemeWithShares(
      scheme,
      shares.map((s) => ({ schemeId, x: s.x, y: s.y }))
    );

    return {
      scheme,
      shares: shares.map((s) => this.envelope(scheme, s)),
      // 仅演示模式回显系数，便于复现手算；随机模式不返回、不保存。
      ...(demo ? { coefficients } : {}),
    };
  }

  /** 导入演示份额（显式给定 x/y，元信息必须一致）。 */
  importShares(opts: {
    threshold: number;
    shareCount: number;
    shares: { x: number; y: string }[];
  }): { scheme: SchemeRow; shares: ShareEnvelope[] } {
    const { threshold, shareCount } = opts;
    try {
      validateParams(threshold, shareCount);
    } catch (err) {
      throw new AppError(ErrorCodes.INVALID_PARAMS, (err as Error).message);
    }
    if (opts.shares.length !== shareCount) {
      throw new AppError(
        ErrorCodes.INVALID_PARAMS,
        `导入份额数 ${opts.shares.length} 与声明的 n=${shareCount} 不一致`
      );
    }
    const schemeId = randomUUID();
    const scheme: SchemeRow = {
      schemeId,
      version: PARAM_VERSION,
      prime: FIELD_PRIME.toString(),
      threshold,
      shareCount,
      mode: "demo",
      createdAt: new Date().toISOString(),
    };
    const validated = opts.shares.map((s) => this.validateSharePoint(s.x, s.y, shareCount));
    this.checkDuplicateX(validated);
    this.store.createSchemeWithShares(
      scheme,
      validated.map((s) => ({ schemeId, x: s.x, y: s.y }))
    );
    return { scheme, shares: validated.map((s) => this.envelope(scheme, s)) };
  }

  /**
   * 从份额恢复秘密。
   * 份额可来自数据库（按 schemeId）或由调用方显式提供（带完整元信息）。
   * 恢复完全由插值计算得出，绝不从数据库读回原秘密（数据库里本来也没有）。
   */
  recover(opts: { schemeId: string; shares?: ShareEnvelope[]; xs?: number[] }): RecoveryResult {
    const scheme = this.store.getScheme(opts.schemeId);
    if (!scheme) {
      throw new AppError(ErrorCodes.SCHEME_NOT_FOUND, `方案不存在：${opts.schemeId}`, 404);
    }

    let points: Share[];
    if (opts.shares && opts.shares.length > 0) {
      points = opts.shares.map((s) => this.validateEnvelope(s, scheme));
    } else {
      const rows = this.store.getShares(opts.schemeId);
      let selected = rows;
      if (opts.xs && opts.xs.length > 0) {
        const wanted = new Set(opts.xs);
        selected = rows.filter((r) => wanted.has(r.x));
        if (selected.length !== wanted.size) {
          const have = new Set(selected.map((r) => r.x));
          const missing = [...wanted].filter((x) => !have.has(x));
          throw new AppError(ErrorCodes.SHARE_NOT_FOUND, `方案中不存在横坐标：${missing.join(", ")}`, 404);
        }
      }
      points = selected.map((r) => ({ x: r.x, y: r.y }));
    }

    this.checkDuplicateX(points);

    if (points.length < scheme.threshold) {
      const err = new AppError(
        ErrorCodes.INSUFFICIENT_SHARES,
        `份额不足：需要至少 t=${scheme.threshold} 个不同份额，实际 ${points.length} 个。` +
          `不足门限时无法恢复原值——这是接口约束，不代表任何猜测值被证明错误。`
      );
      this.recordRecovery(opts.schemeId, "failed", points, err.message);
      throw err;
    }

    // 按横坐标排序选前 t 个构造多项式：输入顺序不影响选点与结果。
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const basisPoints = sorted.slice(0, scheme.threshold);
    const extraPoints = sorted.slice(scheme.threshold);

    let trace: InterpolationTrace;
    try {
      trace = interpolateAtZero(basisPoints);
    } catch (err) {
      const appErr = new AppError(ErrorCodes.NOT_INVERTIBLE, (err as Error).message);
      this.recordRecovery(opts.schemeId, "failed", basisPoints, appErr.message);
      throw appErr;
    }

    // 冗余一致性检查：其余点必须落在同一多项式上。
    const conflicts: number[] = [];
    for (const pt of extraPoints) {
      const expected = evaluateInterpolated(basisPoints, BigInt(pt.x));
      if (expected !== BigInt(pt.y)) {
        conflicts.push(pt.x);
      }
    }
    if (conflicts.length > 0) {
      const err = new AppError(
        ErrorCodes.CONFLICTING_SHARES,
        `额外份额与所选 ${scheme.threshold} 个点确定的多项式不一致，冲突横坐标：${conflicts.join(", ")}。` +
          `注意：这只是冗余一致性检查，恰好 t 个被改动的点仍可能恢复出另一个值，本方案不提供篡改认证。`,
        409,
        { conflicts }
      );
      this.recordRecovery(opts.schemeId, "failed", basisPoints, err.message);
      throw err;
    }

    const recoveryId = randomUUID();
    this.recordRecovery(
      opts.schemeId,
      "success",
      basisPoints,
      `插值成功；核对了 ${extraPoints.length} 个额外份额，全部一致。`
    );
    return {
      recoveryId,
      schemeId: opts.schemeId,
      secret: trace.secret,
      trace,
      consistency: { checkedX: extraPoints.map((p) => p.x), ok: true },
    };
  }

  getScheme(schemeId: string): { scheme: SchemeRow; shares: ShareEnvelope[] } {
    const scheme = this.store.getScheme(schemeId);
    if (!scheme) {
      throw new AppError(ErrorCodes.SCHEME_NOT_FOUND, `方案不存在：${schemeId}`, 404);
    }
    const shares = this.store.getShares(schemeId).map((s) => this.envelope(scheme, s));
    return { scheme, shares };
  }

  listSchemes(): SchemeRow[] {
    return this.store.listSchemes();
  }

  listRecoveries(schemeId: string) {
    return this.store.listRecoveries(schemeId);
  }

  private envelope(scheme: SchemeRow, s: Share): ShareEnvelope {
    return {
      schemeId: scheme.schemeId,
      version: scheme.version,
      prime: scheme.prime,
      threshold: scheme.threshold,
      x: s.x,
      y: s.y,
    };
  }

  /** 校验份额元信息：方案编号、参数版本、素数、门限必须与本方案一致。 */
  private validateEnvelope(s: ShareEnvelope, scheme: SchemeRow): Share {
    if (s.schemeId !== scheme.schemeId) {
      throw new AppError(
        ErrorCodes.SCHEME_MISMATCH,
        `份额属于方案 ${s.schemeId}，不能混入方案 ${scheme.schemeId} 的恢复`
      );
    }
    if (s.version !== scheme.version || s.prime !== scheme.prime || s.threshold !== scheme.threshold) {
      throw new AppError(
        ErrorCodes.SCHEME_MISMATCH,
        `份额元信息 (version=${s.version}, prime=${s.prime}, threshold=${s.threshold}) 与方案参数不一致`
      );
    }
    return this.validateSharePoint(s.x, s.y, scheme.shareCount);
  }

  private validateSharePoint(x: number, y: string, shareCount: number): Share {
    if (!Number.isInteger(x) || x < 1 || x > shareCount || x > MAX_SHARES) {
      throw new AppError(ErrorCodes.X_OUT_OF_RANGE, `横坐标 x=${x} 越界：必须是 1..${shareCount} 的整数（零横坐标非法）`);
    }
    let yb: bigint;
    try {
      yb = BigInt(y);
    } catch {
      throw new AppError(ErrorCodes.INVALID_SHARE, `纵坐标必须是十进制整数，收到：${y}`);
    }
    if (yb < 0n || yb >= FIELD_PRIME) {
      throw new AppError(ErrorCodes.Y_OUT_OF_RANGE, `纵坐标 y=${y} 越界：必须在 0..${FIELD_PRIME - 1n} 内`);
    }
    return { x, y: yb.toString() };
  }

  private checkDuplicateX(points: Share[]): void {
    const seen = new Set<number>();
    for (const p of points) {
      if (seen.has(p.x)) {
        throw new AppError(ErrorCodes.DUPLICATE_X, `重复横坐标 x=${p.x}：每个份额的 x 必须不同`);
      }
      seen.add(p.x);
    }
  }

  private recordRecovery(schemeId: string, status: "success" | "failed", used: Share[], detail: string): void {
    this.store.recordRecovery({
      recoveryId: randomUUID(),
      schemeId,
      status,
      usedX: JSON.stringify(used.map((p) => p.x)),
      detail,
      createdAt: new Date().toISOString(),
    });
  }
}
