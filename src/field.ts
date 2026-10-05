/**
 * 有限域 GF(p) 上的 BigInt 模运算，p = 65537（教学固定参数）。
 * 所有秘密、系数、份额纵坐标都在 [0, p-1] 内。
 */

export const FIELD_PRIME: bigint = 65537n;

/** 规范模运算，结果恒在 [0, p-1]，正确处理负数。 */
export function mod(value: bigint, p: bigint = FIELD_PRIME): bigint {
  const r = value % p;
  return r >= 0n ? r : r + p;
}

export function addMod(a: bigint, b: bigint, p: bigint = FIELD_PRIME): bigint {
  return mod(a + b, p);
}

export function subMod(a: bigint, b: bigint, p: bigint = FIELD_PRIME): bigint {
  return mod(a - b, p);
}

export function mulMod(a: bigint, b: bigint, p: bigint = FIELD_PRIME): bigint {
  return mod(a * b, p);
}

/**
 * 扩展欧几里得算法，返回 { gcd, x, y } 满足 a*x + b*y = gcd。
 */
export function extendedGcd(a: bigint, b: bigint): { gcd: bigint; x: bigint; y: bigint } {
  let oldR = a;
  let r = b;
  let oldS = 1n;
  let s = 0n;
  let oldT = 0n;
  let t = 1n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return { gcd: oldR, x: oldS, y: oldT };
}

/**
 * 模逆：返回 x 使 a*x ≡ 1 (mod p)。
 * a ≡ 0 (mod p) 时逆不存在，抛出错误——绝不能用普通除法替代。
 */
export function invMod(a: bigint, p: bigint = FIELD_PRIME): bigint {
  const na = mod(a, p);
  if (na === 0n) {
    throw new Error(`模逆不存在：${a} ≡ 0 (mod ${p})`);
  }
  const { gcd, x } = extendedGcd(na, p);
  if (gcd !== 1n) {
    throw new Error(`模逆不存在：gcd(${na}, ${p}) = ${gcd} ≠ 1`);
  }
  return mod(x, p);
}
