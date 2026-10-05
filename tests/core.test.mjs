import test from 'node:test';
import assert from 'node:assert/strict';
import {
  P,
  mod,
  sub,
  add,
  mul,
  modInverse,
  div,
} from '../dist/core/field.js';
import {
  createShares,
  recoverSecret,
  validateShares,
  SCHEME_VERSION,
} from '../dist/core/shamir.js';
import { ShamirError } from '../dist/core/errors.js';

const SID = 's1';
const share = (x, y, t = 2) => ({
  schemeId: SID,
  version: SCHEME_VERSION,
  threshold: t,
  x,
  y,
});

test('模逆手算例子：3^-1 ≡ 5 (mod 7)', () => {
  assert.equal(modInverse(3n, 7n), 5n);
  assert.equal(mod(3n * 5n, 7n), 1n);
});

test('GF(65537) 上 3 的逆元满足 3x ≡ 1', () => {
  const inv = modInverse(3n);
  assert.equal(mul(3n, inv), 1n);
});

test('模减法显式处理负数：0 - 1 ≡ p-1', () => {
  assert.equal(sub(0n, 1n), P - 1n);
});

test('无逆元时返回 null（绝不用普通除法替代）', () => {
  assert.equal(modInverse(0n), null);
  assert.throws(() => div(1n, 0n), /模逆不存在/);
});

test('演示夹具：秘密1234 t=2 系数5 → (1,1239)(2,1244)(3,1249)', () => {
  const shares = createShares({
    schemeId: SID,
    secret: 1234n,
    threshold: 2,
    count: 3,
    demo: true,
    demoCoefficients: [5n],
  });
  assert.deepEqual(
    shares.map((s) => [s.x, s.y]),
    [
      [1, 1239],
      [2, 1244],
      [3, 1249],
    ]
  );
});

test('任取两个份额都恢复 1234，且输入顺序不影响结果', () => {
  const pairs = [
    [share(1, 1239), share(2, 1244)],
    [share(2, 1244), share(1, 1239)],
    [share(3, 1249), share(1, 1239)],
    [share(2, 1244), share(3, 1249)],
  ];
  for (const pair of pairs) {
    const { recovered, trace } = recoverSecret(pair);
    assert.equal(recovered, 1234n);
    assert.deepEqual(trace.selectedX, [pair[0].x, pair[1].x].sort((a, b) => a - b));
  }
  // 打乱 (3,1) 时仍选 x 排序后的点
  const { trace } = recoverSecret([share(3, 1249), share(1, 1239)]);
  assert.deepEqual(trace.selectedX, [1, 3]);
});

test('计算过程展示横坐标、基系数与域内贡献', () => {
  const { trace } = recoverSecret([share(1, 1239), share(2, 1244)]);
  // L_1(0) = x2/(x2-x1) = 2/(1) = 2
  assert.equal(trace.terms.find((t) => t.xj === 1).basisCoefficient, '2');
  // L_2(0) = -x1/(x2-x1) = -1 = p-1
  assert.equal(trace.terms.find((t) => t.xj === 2).basisCoefficient, (P - 1n).toString());
  assert.equal(trace.recovered, 1234);
  assert.equal(trace.sumModP, '1234');
});

test('不足门限：接口约束拒绝，不输出秘密 0', () => {
  assert.throws(
    () => recoverSecret([share(1, 1239)]),
    (err) => err instanceof ShamirError && err.code === 'INSUFFICIENT_SHARES'
  );
});

for (const secret of [0n, P - 1n]) {
  test(`边界秘密 ${secret}：枚举所有 t 子集均可恢复`, () => {
    const t = 3;
    const n = 5;
    const shares = createShares({
      schemeId: SID,
      secret,
      threshold: t,
      count: n,
      demo: true,
      demoCoefficients: [0n, 7n],
    });
    // 枚举 C(5,3)
    for (const combo of combinations(
      shares.map((_, i) => i),
      t
    )) {
      const subset = combo.map((i) => shares[i]);
      assert.equal(recoverSecret(subset).recovered, secret);
    }
  });
}

test('零系数合法：常数多项式（所有一次以上系数为0）', () => {
  const shares = createShares({
    schemeId: SID,
    secret: 42n,
    threshold: 3,
    count: 4,
    demo: true,
    demoCoefficients: [0n, 0n],
  });
  assert.ok(shares.every((s) => s.y === 42));
  assert.equal(recoverSecret([shares[0], shares[2], shares[3]]).recovered, 42n);
});

test('不同门限 t=4 恢复', () => {
  const shares = createShares({
    schemeId: SID,
    secret: 60000n,
    threshold: 4,
    count: 6,
    demo: true,
    demoCoefficients: [100n, 200n, 300n],
  });
  assert.equal(
    recoverSecret([shares[5], shares[0], shares[3], shares[1]]).recovered,
    60000n
  );
});

test('重复横坐标拒绝', () => {
  assert.throws(
    () => validateShares([share(1, 10), share(1, 20)], SID, 2),
    (e) => e.code === 'DUPLICATE_X'
  );
});

test('零横坐标拒绝', () => {
  assert.throws(
    () => validateShares([share(0, 10), share(1, 20)], SID, 2),
    (e) => e.code === 'ZERO_X'
  );
});

test('纵坐标越界拒绝', () => {
  assert.throws(
    () => validateShares([share(1, 70000), share(2, 1)], SID, 2),
    (e) => e.code === 'Y_OUT_OF_RANGE'
  );
});

test('混用不同方案拒绝', () => {
  assert.throws(
    () => validateShares([share(1, 10), { ...share(2, 20), schemeId: 'other' }], SID, 2),
    (e) => e.code === 'SCHEME_MISMATCH'
  );
});

test('参数版本必须校验', () => {
  assert.throws(
    () => validateShares([{ ...share(1, 10), version: 'fake' }, share(2, 20)], SID, 2),
    (e) => e.code === 'INVALID_PARAMS'
  );
});

test('多余份额中的冲突点被检测并指出', () => {
  const shares = createShares({
    schemeId: SID,
    secret: 1234n,
    threshold: 2,
    count: 3,
    demo: true,
    demoCoefficients: [5n],
  });
  const tampered = shares.map((s) => (s.x === 3 ? { ...s, y: 9999 } : s));
  assert.throws(
    () => recoverSecret(tampered),
    (e) =>
      e instanceof ShamirError &&
      e.code === 'CONFLICTING_SHARE' &&
      e.details.x === 3 &&
      e.details.expectedY === 1249
  );
});

test('参数校验：t 越界 / t>n / 秘密越界', () => {
  assert.throws(
    () => createShares({ schemeId: SID, secret: 1n, threshold: 11, count: 11 }),
    (e) => e.code === 'THRESHOLD_OUT_OF_RANGE'
  );
  assert.throws(
    () => createShares({ schemeId: SID, secret: 1n, threshold: 3, count: 2 }),
    (e) => e.code === 'THRESHOLD_EXCEEDS_COUNT'
  );
  assert.throws(
    () => createShares({ schemeId: SID, secret: P, threshold: 2, count: 3 }),
    (e) => e.code === 'SECRET_OUT_OF_RANGE'
  );
});

test('演示模式必须显式开启才能注入系数', () => {
  assert.throws(
    () =>
      createShares({
        schemeId: SID,
        secret: 1n,
        threshold: 2,
        count: 3,
        demoCoefficients: [5n],
      }),
    (e) => e.code === 'DEMO_REQUIRED'
  );
});

function combinations(arr, k) {
  const result = [];
  const go = (start, picked) => {
    if (picked.length === k) return result.push([...picked]);
    for (let i = start; i < arr.length; i++) {
      picked.push(arr[i]);
      go(i + 1, picked);
      picked.pop();
    }
  };
  go(0, []);
  return result;
}
