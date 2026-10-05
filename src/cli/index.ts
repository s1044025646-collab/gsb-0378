#!/usr/bin/env node
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../db/database.js';
import { ShamirService, type CreateSchemeInput } from '../service/shamirService.js';
import { ShamirError } from '../core/errors.js';
import type { Share } from '../core/shamir.js';

const DATA_DIR = process.env.SHAMIR_DATA_DIR ?? join(process.cwd(), 'data');
const store = new Store(join(DATA_DIR, 'shamir.db'));
const service = new ShamirService(store);

function parseShares(items: string[]): Share[] {
  return items.map((item) => {
    const parts = item.split(':').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      throw new ShamirError('INVALID_PARAMS', `份额格式应为 门限:x:y，收到 "${item}"`);
    }
    return {
      schemeId: '',
      version: 'shamir-gf65537-v1',
      threshold: parts[0],
      x: parts[1],
      y: parts[2],
    };
  });
}

function printTrace(trace: any): void {
  console.log(`素数域 p = ${trace.prime}`);
  console.log(`选用横坐标（按 x 排序取前 t 个）: ${trace.selectedX.join(', ')}`);
  for (const term of trace.terms) {
    console.log(
      `  x=${term.xj}, y=${term.yj} | 基系数 L(0)=${term.basisCoefficient} | 域内贡献=${term.contribution}`
    );
  }
  if (trace.extraChecks) {
    for (const c of trace.extraChecks) {
      console.log(`  冗余校验 x=${c.x}: 期望 y=${c.expectedY}, 给定 y=${c.givenY}, ${c.ok ? '一致' : '冲突'}`);
    }
  }
  console.log(`模 p 求和（规范整数）= ${trace.sumModP}`);
}

const args = process.argv.slice(2);
const command = args[0];

try {
  if (command === 'create') {
    // create --secret 1234 --t 2 --n 3 [--demo --coeffs 5]
    const opts = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) opts.set(args[i], args[i + 1]);
    const input: CreateSchemeInput = {
      secret: Number(opts.get('--secret')),
      threshold: Number(opts.get('--t')),
      count: Number(opts.get('--n')),
    };
    if (opts.has('--demo')) {
      input.demo = true;
      input.demoCoefficients = (opts.get('--coeffs') ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
    }
    const result = service.createScheme(input);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'get') {
    console.log(JSON.stringify(service.getScheme(args[1]), null, 2));
  } else if (command === 'recover') {
    // recover <schemeId> 2:1:1239 2:3:1249
    const schemeId = args[1];
    const result = service.recover(schemeId, parseShares(args.slice(2)));
    printTrace(result.trace);
    console.log(`恢复结果 = ${result.recovered}`);
  } else if (command === 'export') {
    // export <schemeId> <file> —— 显式样本文件另存
    const [, schemeId, file] = args;
    writeFileSync(file, JSON.stringify(service.getScheme(schemeId), null, 2), 'utf8');
    console.log(`已导出显式样本文件: ${file}`);
  } else if (command === 'recoveries') {
    console.log(JSON.stringify(service.listRecoveries(args[1]), null, 2));
  } else if (command === 'demo') {
    runDemo();
  } else {
    console.log(
      [
        '用法:',
        '  shamir-cli create --secret <整数> --t <2-10> --n <1-10> [--demo --coeffs a,b,...]',
        '  shamir-cli get <schemeId>',
        '  shamir-cli recover <schemeId> <门限:x:y> ...',
        '  shamir-cli export <schemeId> <文件路径>',
        '  shamir-cli recoveries <schemeId>',
        '  shamir-cli demo',
      ].join('\n')
    );
  }
} catch (err) {
  if (err instanceof ShamirError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
} finally {
  store.close();
}

function runDemo(): void {
  console.log('=== 教学演示：秘密 1234，门限 t=2，演示系数 a1=5，GF(65537) ===');
  const scheme = service.createScheme({
    secret: 1234,
    threshold: 2,
    count: 3,
    demo: true,
    demoCoefficients: [5],
  });
  console.log('生成份额:');
  for (const s of scheme.shares) console.log(`  (x=${s.x}, y=${s.y})`);
  const expected = [
    [1, 1239],
    [2, 1244],
    [3, 1249],
  ];
  for (const [x, y] of expected) {
    const got = scheme.shares.find((s) => s.x === x)!;
    if (got.y !== y) throw new Error(`演示夹具不符: x=${x} 期望 y=${y}，实际 ${got.y}`);
  }
  console.log('夹具校验通过：(1,1239)、(2,1244)、(3,1249)');

  console.log('\n--- 任取两个份额恢复（输入顺序打乱：先 x=3 再 x=1）---');
  const r1 = service.recover(scheme.schemeId, [
    { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 3, y: 1249 },
    { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 1239 },
  ]);
  printTrace(r1.trace);
  console.log(`恢复结果 = ${r1.recovered}（应为 1234）`);

  console.log('\n--- 只给一个份额：接口约束拒绝（不等于证明任何猜测错误）---');
  try {
    service.recover(scheme.schemeId, [
      { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 1239 },
    ]);
    throw new Error('应当拒绝不足门限的恢复');
  } catch (err) {
    if (err instanceof ShamirError && err.code === 'INSUFFICIENT_SHARES') {
      console.log(`已拒绝 [${err.code}]: ${err.message}`);
    } else {
      throw err;
    }
  }

  console.log('\n--- 提交 3 个份额，其中一个被篡改：冗余一致性检查应报冲突 ---');
  try {
    service.recover(scheme.schemeId, [
      { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 1, y: 1239 },
      { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 2, y: 1244 },
      { schemeId: '', version: 'shamir-gf65537-v1', threshold: 2, x: 3, y: 9999 },
    ]);
    throw new Error('应当检测到冲突份额');
  } catch (err) {
    if (err instanceof ShamirError && err.code === 'CONFLICTING_SHARE') {
      console.log(`已拒绝 [${err.code}]: ${err.message}`);
      console.log('注意：恰好 t 个被改动的点仍可能恢复成另一个值，本方案不提供篡改认证。');
    } else {
      throw err;
    }
  }
}
