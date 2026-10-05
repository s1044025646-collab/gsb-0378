import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/db/database.js';
import { ShamirService } from '../dist/service/shamirService.js';
import { ShamirError } from '../dist/core/errors.js';

function freshService() {
  const dir = mkdtempSync(join(tmpdir(), 'shamir-'));
  const store = new Store(join(dir, 'sub', 'shamir.db'));
  return { service: new ShamirService(store), store, dir };
}

test('创建方案原子保存：重启后仅凭保存份额可恢复', () => {
  const { service, store, dir } = freshService();
  const created = service.createScheme({
    secret: 1234,
    threshold: 2,
    count: 3,
    demo: true,
    demoCoefficients: [5],
  });
  assert.equal(created.shares.length, 3);
  store.close();

  // 模拟服务重启：新 Store 打开同一数据库
  const store2 = new Store(join(dir, 'sub', 'shamir.db'));
  const service2 = new ShamirService(store2);
  const reloaded = service2.getScheme(created.schemeId);
  assert.equal(reloaded.shares.length, 3);
  const result = service2.recover(created.schemeId, [reloaded.shares[0], reloaded.shares[2]]);
  assert.equal(result.recovered, 1234);
  store2.close();
});

test('恢复不会从数据库偷查原秘密：提供篡改的 t 个点得到的是插值结果而非库中值', () => {
  const { service, store } = freshService();
  const created = service.createScheme({
    secret: 1234,
    threshold: 2,
    count: 3,
    demo: true,
    demoCoefficients: [5],
  });
  // 恰好 t=2 个点都被改 → 恢复出另一条直线的截距（这里是 10+9x 的截距 10）
  const result = service.recover(created.schemeId, [
    { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 19 },
    { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 2, y: 28 },
  ]);
  assert.equal(result.recovered, 10);
  store.close();
});

test('恢复操作状态被记录（含拒绝原因码），不含恢复值', () => {
  const { service, store } = freshService();
  const created = service.createScheme({ secret: 7, threshold: 2, count: 3 });
  service.recover(created.schemeId, [created.shares[0], created.shares[1]]);
  assert.throws(
    () => service.recover(created.schemeId, [created.shares[0]]),
    (e) => e.code === 'INSUFFICIENT_SHARES'
  );
  const recs = service.listRecoveries(created.schemeId);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].status, 'rejected');
  assert.equal(recs[0].reasonCode, 'INSUFFICIENT_SHARES');
  assert.equal(recs[1].status, 'success');
  for (const r of recs) {
    assert.ok(!JSON.stringify(r).includes('"recovered"'));
  }
  store.close();
});

test('事务失败不留下半成品（UNIQUE 冲突整体回滚）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shamir-'));
  const store = new Store(join(dir, 'shamir.db'));
  const badShares = [
    { schemeId: 'x', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 10 },
    { schemeId: 'x', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 11 },
  ];
  assert.throws(() =>
    store.saveSchemeAndShares(
      { id: 'x', version: 'shamir-gf65537-v1', threshold: 2, shareCount: 2, demo: 0, createdAt: new Date().toISOString() },
      badShares
    )
  );
  assert.equal(store.getScheme('x'), null);
  assert.deepEqual(store.getShares('x'), []);
  store.close();
});

test('数量不符直接拒绝（原子性断言）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shamir-'));
  const store = new Store(join(dir, 'shamir.db'));
  assert.throws(() =>
    store.saveSchemeAndShares(
      { id: 'y', version: 'shamir-gf65537-v1', threshold: 2, shareCount: 3, demo: 0, createdAt: '' },
      [{ schemeId: 'y', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 1 }]
    )
  );
  store.close();
});

test('默认随机模式：零秘密随机份额可恢复，且份额不恒为 0', () => {
  const { service, store } = freshService();
  const created = service.createScheme({ secret: 0, threshold: 3, count: 5 });
  const { recovered } = service.recover(created.schemeId, [
    created.shares[0],
    created.shares[2],
    created.shares[4],
  ]);
  assert.equal(recovered, 0);
  assert.ok(created.shares.some((s) => s.y !== 0));
  store.close();
});
