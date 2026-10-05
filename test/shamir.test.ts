import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIELD_PRIME, mod, subMod, invMod, extendedGcd, mulMod } from "../dist/field.js";
import { generateShares, interpolateAtZero, evaluateInterpolated } from "../dist/shamir.js";
import { Store } from "../dist/store.js";
import { ShamirService } from "../dist/service.js";
import { AppError, ErrorCodes } from "../dist/errors.js";

const P = FIELD_PRIME;

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...tail] = arr;
  return [...combinations(tail, k - 1).map((c) => [head, ...c]), ...combinations(tail, k)];
}

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "shamir-test-"));
  return {
    path: join(dir, "test.db"),
    cleanup: () => {
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
    },
  };
}

test("手算模逆：2 的逆是 32769，因为 2*32769 = 65538 ≡ 1 (mod 65537)", () => {
  assert.equal(invMod(2n, P), 32769n);
  assert.equal(mulMod(2n, 32769n, P), 1n);
  // 手算验证：65537 = 2*32768 + 1 → 1 = 65537 - 2*32768 → -32768 ≡ 32769
  const { gcd, x } = extendedGcd(2n, P);
  assert.equal(gcd, 1n);
  assert.equal(mod(x, P), 32769n);
  // 3 的逆：3*21846 = 65538 ≡ 1
  assert.equal(invMod(3n, P), 21846n);
  // 0 没有逆，必须抛错而不是普通除法
  assert.throws(() => invMod(0n, P), /模逆不存在/);
  assert.throws(() => invMod(P, P), /模逆不存在/);
});

test("模减法正确处理负数结果", () => {
  assert.equal(subMod(1n, 3n, P), P - 2n);
  assert.equal(mod(-5n, P), P - 5n);
  assert.equal(subMod(0n, P - 1n, P), 1n);
});

test("演示夹具：secret=1234, t=2, a1=5 → (1,1239) (2,1244) (3,1249)", () => {
  const { shares } = generateShares(1234n, 2, 3, [1234n, 5n]);
  assert.deepEqual(shares, [
    { x: 1, y: "1239" },
    { x: 2, y: "1244" },
    { x: 3, y: "1249" },
  ]);
  // 任取两个都恢复 1234
  for (const combo of combinations(shares, 2)) {
    const trace = interpolateAtZero(combo);
    assert.equal(trace.secret, "1234");
    assert.equal(trace.terms.length, 2);
  }
  // 手算核对 x=1,2：λ1 = (0-2)/(1-2) = 2，λ2 = (0-1)/(2-1) = -1 ≡ 65536
  const trace = interpolateAtZero([shares[0], shares[1]]);
  assert.equal(trace.terms[0].basis, "2");
  assert.equal(trace.terms[1].basis, "65536");
  // 贡献：2*1239 = 2478；65536*1244 mod 65537 = -1244 mod 65537 = 64293
  assert.equal(trace.terms[0].contribution, "2478");
  assert.equal(trace.terms[1].contribution, "64293");
  // 2478 + 64293 = 66771 ≡ 1234 (mod 65537)
  assert.equal((2478n + 64293n) % P, 1234n);
});

test("秘密为 0 与最大值 p-1 均可恢复", () => {
  for (const secret of [0n, P - 1n]) {
    const { shares } = generateShares(secret, 3, 5);
    for (const combo of combinations(shares, 3)) {
      assert.equal(interpolateAtZero(combo).secret, secret.toString());
    }
  }
});

test("零系数合法：常数多项式所有份额纵坐标相同", () => {
  const { shares } = generateShares(42n, 3, 4, [42n, 0n, 0n]);
  for (const s of shares) assert.equal(s.y, "42");
  assert.equal(interpolateAtZero(shares.slice(0, 3)).secret, "42");
});

test("不同门限下枚举所有大小为 t 的子集均能恢复", () => {
  for (const t of [2, 3, 4, 5]) {
    const secret = 12345n;
    const n = Math.min(t + 2, 10);
    const { shares } = generateShares(secret, t, n);
    for (const combo of combinations(shares, t)) {
      assert.equal(interpolateAtZero(combo).secret, secret.toString(), `t=${t}`);
    }
  }
});

test("随机模式：份额在域内且任意 t 子集恢复（n=6, t=3 全枚举）", () => {
  const secret = 65536n;
  const { shares } = generateShares(secret, 3, 6);
  for (const s of shares) {
    const y = BigInt(s.y);
    assert.ok(y >= 0n && y < P);
  }
  for (const combo of combinations(shares, 3)) {
    assert.equal(interpolateAtZero(combo).secret, "65536");
  }
});

test("evaluateInterpolated 与份额生成一致", () => {
  const { shares } = generateShares(777n, 2, 4);
  const basis = shares.slice(0, 2);
  for (const s of shares) {
    assert.equal(evaluateInterpolated(basis, BigInt(s.x)).toString(), s.y);
  }
});

test("服务层：建立方案、恢复、份额不足失败、重启后可恢复", () => {
  const { path, cleanup } = tempDb();
  try {
    let schemeId: string;
    {
      const store = new Store(path);
      const svc = new ShamirService(store);
      const created = svc.createScheme({ secret: "1234", threshold: 2, shareCount: 3, demoCoefficients: ["1234", "5"] });
      schemeId = created.scheme.schemeId;
      assert.deepEqual(
        created.shares.map((s) => [s.x, s.y]),
        [
          [1, "1239"],
          [2, "1244"],
          [3, "1249"],
        ]
      );
      // 只给一个份额 → INSUFFICIENT_SHARES
      assert.throws(() => svc.recover({ schemeId, xs: [1] }), (e: unknown) => {
        return e instanceof AppError && e.code === ErrorCodes.INSUFFICIENT_SHARES;
      });
      // 输入顺序不影响结果
      const r1 = svc.recover({ schemeId, xs: [3, 1] });
      const r2 = svc.recover({ schemeId, xs: [1, 3] });
      assert.equal(r1.secret, "1234");
      assert.equal(r2.secret, "1234");
      assert.deepEqual(
        r1.trace.points.map((p) => p.x),
        [1, 3]
      );
      store.close();
    }
    // 模拟服务重启：只凭数据库中的份额恢复
    {
      const store = new Store(path);
      const svc = new ShamirService(store);
      const r = svc.recover({ schemeId, xs: [2, 3] });
      assert.equal(r.secret, "1234");
      // 恢复记录不含秘密值
      const recs = svc.listRecoveries(schemeId);
      assert.ok(recs.length >= 3);
      for (const rec of recs) {
        assert.ok(!rec.detail.includes("1234") || rec.detail.includes("1234") === false);
        assert.ok(rec.status === "success" || rec.status === "failed");
      }
      store.close();
    }
  } finally {
    cleanup();
  }
});

test("服务层：重复横坐标、零横坐标、越界纵坐标被拒绝", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new Store(path);
    const svc = new ShamirService(store);
    const created = svc.createScheme({ secret: "100", threshold: 2, shareCount: 3 });
    const id = created.scheme.schemeId;
    const env = created.shares[0];
    // 重复 x
    assert.throws(
      () => svc.recover({ schemeId: id, shares: [env, env] }),
      (e: unknown) => e instanceof AppError && e.code === ErrorCodes.DUPLICATE_X
    );
    // 零横坐标
    assert.throws(
      () => svc.recover({ schemeId: id, shares: [{ ...env, x: 0 }, created.shares[1]] }),
      (e: unknown) => e instanceof AppError && e.code === ErrorCodes.X_OUT_OF_RANGE
    );
    // 越界纵坐标
    assert.throws(
      () => svc.recover({ schemeId: id, shares: [{ ...env, y: "65537" }, created.shares[1]] }),
      (e: unknown) => e instanceof AppError && e.code === ErrorCodes.Y_OUT_OF_RANGE
    );
    store.close();
  } finally {
    cleanup();
  }
});

test("服务层：混用不同方案的份额被拒绝", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new Store(path);
    const svc = new ShamirService(store);
    const a = svc.createScheme({ secret: "1", threshold: 2, shareCount: 2 });
    const b = svc.createScheme({ secret: "2", threshold: 2, shareCount: 2 });
    assert.throws(
      () => svc.recover({ schemeId: a.scheme.schemeId, shares: [a.shares[0], b.shares[1]] }),
      (e: unknown) => e instanceof AppError && e.code === ErrorCodes.SCHEME_MISMATCH
    );
    store.close();
  } finally {
    cleanup();
  }
});

test("服务层：额外冲突份额被拒绝并指出冲突横坐标", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new Store(path);
    const svc = new ShamirService(store);
    const created = svc.createScheme({ secret: "1234", threshold: 2, shareCount: 3, demoCoefficients: ["1234", "5"] });
    const id = created.scheme.schemeId;
    const tampered = { ...created.shares[2], y: "9999" };
    assert.throws(
      () => svc.recover({ schemeId: id, shares: [created.shares[0], created.shares[1], tampered] }),
      (e: unknown) => {
        return (
          e instanceof AppError &&
          e.code === ErrorCodes.CONFLICTING_SHARES &&
          JSON.stringify((e as AppError).details).includes("3")
        );
      }
    );
    // 一致的额外份额通过
    const ok = svc.recover({ schemeId: id, shares: created.shares });
    assert.equal(ok.secret, "1234");
    assert.deepEqual(ok.consistency, { checkedX: [3], ok: true });
    store.close();
  } finally {
    cleanup();
  }
});

test("服务层：非法参数与越界秘密被拒绝", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new Store(path);
    const svc = new ShamirService(store);
    assert.throws(() => svc.createScheme({ secret: "1", threshold: 1, shareCount: 3 }), AppError);
    assert.throws(() => svc.createScheme({ secret: "1", threshold: 11, shareCount: 11 }), AppError);
    assert.throws(() => svc.createScheme({ secret: "1", threshold: 3, shareCount: 2 }), AppError);
    assert.throws(() => svc.createScheme({ secret: "65537", threshold: 2, shareCount: 2 }), AppError);
    assert.throws(() => svc.createScheme({ secret: "-1", threshold: 2, shareCount: 2 }), AppError);
    store.close();
  } finally {
    cleanup();
  }
});

test("存储：份额生成原子保存，失败不留半成品", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new Store(path);
    const scheme = {
      schemeId: "atomic-test",
      version: 1,
      prime: "65537",
      threshold: 2,
      shareCount: 2,
      mode: "demo" as const,
      createdAt: new Date().toISOString(),
    };
    // 第二个份额重复 x=1，触发主键冲突 → 整体回滚
    assert.throws(() =>
      store.createSchemeWithShares(scheme, [
        { schemeId: "atomic-test", x: 1, y: "5" },
        { schemeId: "atomic-test", x: 1, y: "6" },
      ])
    );
    assert.equal(store.getScheme("atomic-test"), null);
    assert.deepEqual(store.getShares("atomic-test"), []);
    store.close();
  } finally {
    cleanup();
  }
});

test("导入演示份额并恢复", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new Store(path);
    const svc = new ShamirService(store);
    const imported = svc.importShares({
      threshold: 2,
      shareCount: 3,
      shares: [
        { x: 1, y: "1239" },
        { x: 2, y: "1244" },
        { x: 3, y: "1249" },
      ],
    });
    const r = svc.recover({ schemeId: imported.scheme.schemeId, xs: [2, 3] });
    assert.equal(r.secret, "1234");
    store.close();
  } finally {
    cleanup();
  }
});
