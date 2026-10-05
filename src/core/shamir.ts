import {
  P,
  add,
  sub,
  mul,
  modInverse,
  mod,
} from './field.js';
import { ShamirError } from './errors.js';
import { randomInt } from 'node:crypto';

export const MIN_T = 2;
export const MAX_T = 10;
export const MAX_N = 10;

export const SCHEME_VERSION = 'shamir-gf65537-v1';

export interface Share {
  schemeId: string;
  version: string;
  threshold: number;
  x: number;
  y: number;
}

export interface LagrangeTerm {
  xj: number;
  yj: number;
  basisCoefficient: string; // 基多项式 L_j(0) 的域内值（十进制字符串）
  contribution: string; // yj * L_j(0) mod p
}

export interface RecoverTrace {
  prime: string;
  selectedX: number[];
  terms: LagrangeTerm[];
  sumModP: string;
  recovered: number;
  extraChecks?: { x: number; expectedY: number; givenY: number; ok: boolean }[];
}

export function assertThresholdCount(t: number, n: number): void {
  if (!Number.isInteger(t) || t < MIN_T || t > MAX_T) {
    throw new ShamirError(
      'THRESHOLD_OUT_OF_RANGE',
      `门限 t 必须是 ${MIN_T} 到 ${MAX_T} 的整数，收到 ${String(t)}`
    );
  }
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) {
    throw new ShamirError(
      'SHARE_COUNT_OUT_OF_RANGE',
      `份额数 n 必须是 1 到 ${MAX_N} 的整数，收到 ${String(n)}`
    );
  }
  if (t > n) {
    throw new ShamirError(
      'THRESHOLD_EXCEEDS_COUNT',
      `门限 t=${t} 不能超过份额数 n=${n}`
    );
  }
}

export function assertSecret(secret: bigint): void {
  if (
    typeof secret !== 'bigint' ||
    secret < 0n ||
    secret > P - 1n
  ) {
    throw new ShamirError(
      'SECRET_OUT_OF_RANGE',
      `秘密必须在 [0, ${P - 1n}] 范围内，收到 ${String(secret)}`
    );
  }
}

/**
 * 使用 crypto.randomInt 的拒绝采样，在 [0, p-1] 上均匀取一个系数。
 * crypto.randomInt 内部对非 2 的幂范围已做拒绝采样，无取模偏差。
 * 零系数完全合法，不为强制最高次数非零而重抽。
 */
export function randomCoefficient(): bigint {
  return BigInt(randomInt(0, Number(P)));
}

/** Horner 求值：f(x) = a0 + a1 x + ... + a_{t-1} x^{t-1} (mod p) */
export function evalPoly(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = add(mul(acc, x), coeffs[i]);
  }
  return acc;
}

export interface CreateSharesInput {
  schemeId: string;
  secret: bigint;
  threshold: number;
  count: number;
  /** 演示模式：注入固定系数（长度须为 t-1），显式标注后才可使用 */
  demoCoefficients?: bigint[];
  demo?: boolean;
}

export function createShares(input: CreateSharesInput): Share[] {
  const { schemeId, secret, threshold: t, count: n } = input;
  assertSecret(secret);
  assertThresholdCount(t, n);

  let coeffs: bigint[];
  if (input.demo || input.demoCoefficients) {
    if (!input.demo || !input.demoCoefficients) {
      throw new ShamirError(
        'DEMO_REQUIRED',
        '注入固定系数必须显式开启演示模式（demo=true 且提供 demoCoefficients）'
      );
    }
    if (input.demoCoefficients.length !== t - 1) {
      throw new ShamirError(
        'INVALID_PARAMS',
        `演示系数长度必须为 t-1=${t - 1}，收到 ${input.demoCoefficients.length}`
      );
    }
    for (const c of input.demoCoefficients) {
      if (typeof c !== 'bigint' || c < 0n || c > P - 1n) {
        throw new ShamirError(
          'COEFFICIENT_OUT_OF_RANGE',
          `演示系数必须在 [0, ${P - 1n}] 范围内，收到 ${String(c)}`
        );
      }
    }
    coeffs = [secret, ...input.demoCoefficients];
  } else {
    coeffs = [secret];
    for (let i = 1; i < t; i++) coeffs.push(randomCoefficient());
  }

  const shares: Share[] = [];
  for (let x = 1; x <= n; x++) {
    shares.push({
      schemeId,
      version: SCHEME_VERSION,
      threshold: t,
      x,
      y: Number(evalPoly(coeffs, BigInt(x))),
    });
  }
  return shares;
}

/**
 * 校验一批份额的元信息与取值（不查询数据库中的秘密）。
 */
export function validateShares(
  shares: Share[],
  expectedSchemeId?: string,
  expectedThreshold?: number
): void {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new ShamirError('INVALID_PARAMS', '份额列表为空');
  }
  const seenX = new Set<number>();
  const schemeId = expectedSchemeId ?? shares[0].schemeId;
  const threshold = expectedThreshold ?? shares[0].threshold;
  for (const s of shares) {
    if (s.version !== SCHEME_VERSION) {
      throw new ShamirError(
        'INVALID_PARAMS',
        `参数版本不支持：${String(s.version)}，期望 ${SCHEME_VERSION}`
      );
    }
    if (s.schemeId !== schemeId) {
      throw new ShamirError(
        'SCHEME_MISMATCH',
        `混用了不同方案的份额：${s.schemeId} 与 ${schemeId}`,
        { shareSchemeId: s.schemeId, expectedSchemeId: schemeId }
      );
    }
    if (s.threshold !== threshold) {
      throw new ShamirError(
        'SCHEME_MISMATCH',
        `份额门限元信息不一致：${s.threshold} 与 ${threshold}`
      );
    }
    if (s.x === 0) {
      throw new ShamirError('ZERO_X', '横坐标不能为 0（0 号点对应秘密本身，永不分配）');
    }
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > MAX_N) {
      throw new ShamirError(
        'X_OUT_OF_RANGE',
        `横坐标必须是 1 到 ${MAX_N} 的整数，收到 ${String(s.x)}`
      );
    }
    if (!Number.isInteger(s.y) || BigInt(s.y) < 0n || BigInt(s.y) > P - 1n) {
      throw new ShamirError(
        'Y_OUT_OF_RANGE',
        `纵坐标必须在 [0, ${P - 1n}] 范围内，收到 ${String(s.y)}`
      );
    }
    if (seenX.has(s.x)) {
      throw new ShamirError('DUPLICATE_X', `重复横坐标 x=${s.x}`);
    }
    seenX.add(s.x);
  }
  if (expectedThreshold !== undefined && threshold !== expectedThreshold) {
    throw new ShamirError(
      'SCHEME_MISMATCH',
      `份额门限 ${threshold} 与方案门限 ${expectedThreshold} 不一致`
    );
  }
}

/**
 * Lagrange 在 x=0 处的恢复（常数项即秘密）。
 * 基系数：L_j(0) = Π_{m≠j} x_m / (x_m - x_j)  (mod p)
 * 模逆不存在时直接报错，绝不使用普通除法。
 */
export function recoverSecret(shares: Share[]): { recovered: bigint; trace: RecoverTrace } {
  validateShares(shares);
  const t = shares[0].threshold;
  if (shares.length < t) {
    // 不足门限是接口约束：拒绝并说明，绝不把失败当作秘密 0。
    throw new ShamirError(
      'INSUFFICIENT_SHARES',
      `恢复需要 ${t} 个不同份额，仅提供 ${shares.length} 个`
    );
  }

  // 输入顺序无关：按横坐标排序，选前 t 个构造多项式。
  const sorted = [...shares].sort((a, b) => a.x - b.x);
  const chosen = sorted.slice(0, t);
  const extra = sorted.slice(t);

  const points = chosen.map((s) => ({ x: BigInt(s.x), y: BigInt(s.y), raw: s }));
  const terms: LagrangeTerm[] = [];
  let secret = 0n;

  for (let j = 0; j < points.length; j++) {
    let numerator = 1n;
    let denominator = 1n;
    for (let m = 0; m < points.length; m++) {
      if (m === j) continue;
      // L_j(0) 的每个因子：(0 - x_m) / (x_j - x_m)，逐因子取模，符号不做额外处理。
      numerator = mul(numerator, mod(-points[m].x));
      denominator = mul(denominator, sub(points[j].x, points[m].x));
    }
    const inv = modInverse(denominator);
    if (inv === null) {
      throw new ShamirError(
        'INTERNAL_ERROR',
        `模逆不存在（分母=${denominator}），不同横坐标在素数域上不应触发此错误`
      );
    }
    const basis = mul(numerator, inv);
    const contribution = mul(points[j].y, basis);
    secret = add(secret, contribution);
    terms.push({
      xj: points[j].raw.x,
      yj: points[j].raw.y,
      basisCoefficient: basis.toString(),
      contribution: contribution.toString(),
    });
  }

  // 冗余一致性检查：其余份额必须落在同一 t-1 次多项式上。
  const coeffs = interpolateCoeffs(points);
  const extraChecks = extra.map((s) => {
    const expectedY = Number(evalPoly(coeffs, BigInt(s.x)));
    return { x: s.x, expectedY, givenY: s.y, ok: expectedY === s.y };
  });
  const conflict = extraChecks.find((c) => !c.ok);
  if (conflict) {
    throw new ShamirError(
      'CONFLICTING_SHARE',
      `额外份额 x=${conflict.x} 与由前 ${t} 个点确定的多项式冲突：应为 y=${conflict.expectedY}，实际 y=${conflict.givenY}`,
      conflict
    );
  }

  const trace: RecoverTrace = {
    prime: P.toString(),
    selectedX: chosen.map((s) => s.x),
    terms,
    sumModP: secret.toString(),
    recovered: Number(secret),
  };
  if (extraChecks.length > 0) trace.extraChecks = extraChecks;
  return { recovered: secret, trace };
}

/**
 * 由 t 个点求出多项式系数（用于额外点的一致性检查），
 * 使用模域高斯消元解 Vandermonde 方程组。
 */
function interpolateCoeffs(points: { x: bigint; y: bigint }[]): bigint[] {
  const t = points.length;
  const matrix: bigint[][] = points.map((pt) => {
    const row: bigint[] = [];
    let power = 1n;
    for (let k = 0; k < t; k++) {
      row.push(power);
      power = mul(power, pt.x);
    }
    row.push(pt.y);
    return row;
  });

  for (let col = 0; col < t; col++) {
    const pivot = matrix[col][col];
    const inv = modInverse(pivot);
    if (inv === null) throw new ShamirError('INTERNAL_ERROR', '插值消元主元无逆元');
    for (let k = col; k <= t; k++) matrix[col][k] = mul(matrix[col][k], inv);
    for (let row = 0; row < t; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let k = col; k <= t; k++) {
        matrix[row][k] = sub(matrix[row][k], mul(factor, matrix[col][k]));
      }
    }
  }
  return matrix.map((row) => row[t]);
}
