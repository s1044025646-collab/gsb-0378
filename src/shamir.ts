import { FIELD_PRIME, addMod, mulMod, subMod, invMod, mod } from "./field.js";
import { randomFieldElement } from "./random.js";

export interface Share {
  x: number;
  y: string; // 十进制字符串，避免精度问题
}

export interface InterpolationTerm {
  x: number;
  y: string;
  /** Lagrange 基系数 λ_i = Π_{j≠i} (0 - x_j) / (x_i - x_j) (mod p) */
  basis: string;
  /** 域内贡献 λ_i * y_i (mod p) */
  contribution: string;
}

export interface InterpolationTrace {
  p: string;
  points: { x: number; y: string }[];
  terms: InterpolationTerm[];
  secret: string;
}

export const MIN_THRESHOLD = 2;
export const MAX_THRESHOLD = 10;
export const MAX_SHARES = 10;

export function validateParams(threshold: number, shareCount: number): void {
  if (!Number.isInteger(threshold) || !Number.isInteger(shareCount)) {
    throw new Error("门限与份额数必须为整数");
  }
  if (threshold < MIN_THRESHOLD || threshold > MAX_THRESHOLD) {
    throw new Error(`门限 t 必须在 ${MIN_THRESHOLD}..${MAX_THRESHOLD} 之间`);
  }
  if (shareCount > MAX_SHARES) {
    throw new Error(`份额数 n 最多为 ${MAX_SHARES}`);
  }
  if (threshold > shareCount) {
    throw new Error("门限 t 不能超过份额数 n");
  }
}

export function validateSecret(secret: bigint): void {
  if (secret < 0n || secret >= FIELD_PRIME) {
    throw new Error(`秘密必须在 0..${FIELD_PRIME - 1n} 范围内`);
  }
}

/**
 * 生成份额：f(x) = secret + a1*x + ... + a_{t-1}*x^{t-1} (mod p)，x = 1..n。
 * 默认系数来自系统随机源（拒绝采样）；demoCoefficients 用于演示模式复现手算。
 * 零系数合法，不做任何强制非零处理。
 */
export function generateShares(
  secret: bigint,
  threshold: number,
  shareCount: number,
  demoCoefficients?: bigint[]
): { shares: Share[]; coefficients: string[] } {
  validateParams(threshold, shareCount);
  validateSecret(secret);

  let coefficients: bigint[];
  if (demoCoefficients !== undefined) {
    if (demoCoefficients.length !== threshold) {
      throw new Error(`演示模式需要恰好 ${threshold} 个系数（含常数项）`);
    }
    coefficients = demoCoefficients.map((c) => {
      if (c < 0n || c >= FIELD_PRIME) {
        throw new Error(`演示系数 ${c} 越界，必须在 0..${FIELD_PRIME - 1n}`);
      }
      return c;
    });
    if (coefficients[0] !== secret) {
      throw new Error("演示系数的首项（常数项）必须等于秘密");
    }
  } else {
    coefficients = [secret];
    for (let i = 1; i < threshold; i++) {
      coefficients.push(randomFieldElement());
    }
  }

  const shares: Share[] = [];
  for (let x = 1; x <= shareCount; x++) {
    // Horner 法则在域内求值
    let y = 0n;
    for (let i = coefficients.length - 1; i >= 0; i--) {
      y = addMod(mulMod(y, BigInt(x)), coefficients[i]);
    }
    shares.push({ x, y: y.toString() });
  }
  return { shares, coefficients: coefficients.map((c) => c.toString()) };
}

/**
 * Lagrange 零点插值：从恰好 t 个点恢复 f(0)。
 * 返回完整计算过程（所选横坐标、每项基系数、域内贡献）。
 */
export function interpolateAtZero(points: Share[], p: bigint = FIELD_PRIME): InterpolationTrace {
  const terms: InterpolationTerm[] = [];
  let secret = 0n;
  for (let i = 0; i < points.length; i++) {
    const xi = BigInt(points[i].x);
    const yi = BigInt(points[i].y);
    let numerator = 1n;
    let denominator = 1n;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const xj = BigInt(points[j].x);
      numerator = mulMod(numerator, subMod(0n, xj, p), p);
      denominator = mulMod(denominator, subMod(xi, xj, p), p);
    }
    const basis = mulMod(numerator, invMod(denominator, p), p);
    const contribution = mulMod(basis, yi, p);
    secret = addMod(secret, contribution, p);
    terms.push({
      x: points[i].x,
      y: yi.toString(),
      basis: basis.toString(),
      contribution: contribution.toString(),
    });
  }
  return {
    p: p.toString(),
    points: points.map((pt) => ({ x: pt.x, y: pt.y.toString() })),
    terms,
    secret: mod(secret, p).toString(),
  };
}

/** 在域内求值由 points 唯一确定的次数 < k 多项式在 x 处的值（用于核对额外份额）。 */
export function evaluateInterpolated(points: Share[], x: bigint, p: bigint = FIELD_PRIME): bigint {
  let result = 0n;
  for (let i = 0; i < points.length; i++) {
    const xi = BigInt(points[i].x);
    const yi = BigInt(points[i].y);
    let numerator = 1n;
    let denominator = 1n;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const xj = BigInt(points[j].x);
      numerator = mulMod(numerator, subMod(x, xj, p), p);
      denominator = mulMod(denominator, subMod(xi, xj, p), p);
    }
    result = addMod(result, mulMod(yi, mulMod(numerator, invMod(denominator, p), p), p), p);
  }
  return mod(result, p);
}
