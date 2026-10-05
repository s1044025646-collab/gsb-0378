import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { Store } from '../db/database.js';
import { ShamirService } from '../service/shamirService.js';
import { ShamirError, type ErrorCode } from '../core/errors.js';
import type { Share } from '../core/shamir.js';

const DATA_DIR = process.env.SHAMIR_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'shamir.db');

function chooseFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('无法获取空闲端口'));
      });
    });
    srv.on('error', reject);
  });
}

const store = new Store(DB_PATH);
const service = new ShamirService(store);

// 常规日志只记录方法、路径、状态码与错误码，不打印秘密/系数/恢复值。
function log(line: string): void {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new ShamirError('INVALID_PARAMS', '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ShamirError('INVALID_PARAMS', 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_PARAMS: 400,
  SECRET_OUT_OF_RANGE: 400,
  THRESHOLD_OUT_OF_RANGE: 400,
  SHARE_COUNT_OUT_OF_RANGE: 400,
  THRESHOLD_EXCEEDS_COUNT: 400,
  COEFFICIENT_OUT_OF_RANGE: 400,
  SCHEME_NOT_FOUND: 404,
  SHARE_NOT_FOUND: 404,
  DUPLICATE_X: 400,
  ZERO_X: 400,
  Y_OUT_OF_RANGE: 400,
  X_OUT_OF_RANGE: 400,
  SCHEME_MISMATCH: 409,
  INSUFFICIENT_SHARES: 422,
  CONFLICTING_SHARE: 409,
  DEMO_REQUIRED: 400,
  NOT_ATOMIC: 500,
  INTERNAL_ERROR: 500,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true, prime: '65537', version: 'shamir-gf65537-v1' });
      return;
    }

    if (req.method === 'POST' && path === '/schemes') {
      const body = await readJson(req);
      const result = service.createScheme({
        secret: Number(body.secret),
        threshold: Number(body.threshold),
        count: Number(body.count),
        demo: Boolean(body.demo),
        demoCoefficients: body.demoCoefficients,
      });
      send(res, 201, result);
      log(`POST /schemes -> 201 id=${result.schemeId}`);
      return;
    }

    const schemeMatch = path.match(/^\/schemes\/([^/]+)$/);
    if (req.method === 'GET' && schemeMatch) {
      send(res, 200, service.getScheme(schemeMatch[1]));
      return;
    }

    const recoverMatch = path.match(/^\/schemes\/([^/]+)\/recover$/);
    if (req.method === 'POST' && recoverMatch) {
      const body = await readJson(req);
      const shares: Share[] = (body.shares ?? []).map((s: any) => ({
        schemeId: recoverMatch[1],
        version: 'shamir-gf65537-v1',
        threshold: Number(s.threshold),
        x: Number(s.x),
        y: Number(s.y),
      }));
      const result = service.recover(recoverMatch[1], shares);
      send(res, 200, result);
      log(`POST /recover -> 200 scheme=${recoverMatch[1]}`);
      return;
    }

    const recMatch = path.match(/^\/schemes\/([^/]+)\/recoveries$/);
    if (req.method === 'GET' && recMatch) {
      send(res, 200, service.listRecoveries(recMatch[1]));
      return;
    }

    send(res, 404, { error: { code: 'INVALID_PARAMS', message: '未知路由' } });
  } catch (err) {
    if (err instanceof ShamirError) {
      const status = ERROR_STATUS[err.code] ?? 500;
      send(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      log(`${req.method ?? ''} ${path} -> ${status} ${err.code}`);
    } else {
      send(res, 500, { error: { code: 'INTERNAL_ERROR', message: '内部错误' } });
      log(`${req.method ?? ''} ${path} -> 500`);
    }
  }
});

const configuredPort = process.env.PORT ? Number(process.env.PORT) : NaN;
const port = Number.isInteger(configuredPort) ? configuredPort : await chooseFreePort();

server.listen(port, '127.0.0.1', () => {
  log(`Shamir 教学后端已启动: http://127.0.0.1:${port}`);
  log(`数据目录: ${DATA_DIR}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
