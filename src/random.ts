import { randomInt } from "node:crypto";
import { FIELD_PRIME } from "./field.js";

/**
 * 从系统随机源均匀采样 [0, p-1] 的域元素。
 * 使用拒绝采样：样本空间取 p 的整数倍，落在有效区间外的样本丢弃，
 * 避免直接对随机字节取模带来的模偏差。
 */
export function randomFieldElement(p: bigint = FIELD_PRIME): bigint {
  const pNum = Number(p);
  // k*p <= 2^48，位于 randomInt 的安全上界内。
  const k = Math.floor(2 ** 48 / pNum);
  const limit = k * pNum;
  for (;;) {
    const v = randomInt(0, limit);
    if (v < limit) {
      return BigInt(v % pNum);
    }
  }
}
