// 素数域 GF(65537) 上的 BigInt 模运算。
// 所有运算均在整数域内显式取模，绝不使用普通实数除法替代模逆。

export const P = 65537n;
export const FIELD_MIN = 0n;
export const FIELD_MAX = P - 1n;

export function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

export function add(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

export function sub(a: bigint, b: bigint): bigint {
  // 显式处理模减法为负的情况。
  return mod(a - b);
}

export function mul(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

export function pow(a: bigint, e: bigint): bigint {
  let base = mod(a);
  let exp = e;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mul(result, base);
    base = mul(base, base);
    exp >>= 1n;
  }
  return result;
}

/**
 * 扩展欧几里得算法求模逆。
 * 返回 x 使得 a*x ≡ 1 (mod m)；当 gcd(a,m) !== 1 时不存在逆元，返回 null。
 * 调用方必须检查 null，绝不允许回退为普通除法。
 */
export function modInverse(a: bigint, m: bigint = P): bigint | null {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) return null; // 逆元不存在
  return mod(oldS, m);
}

export function div(a: bigint, b: bigint): bigint {
  const inv = modInverse(b);
  if (inv === null) {
    throw new Error(`模逆不存在: ${b} 在 GF(${P}) 上没有乘法逆元`);
  }
  return mul(a, inv);
}
