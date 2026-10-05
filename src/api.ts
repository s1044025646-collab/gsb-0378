import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { AddressInfo } from "node:net";
import { ShamirService } from "./service.js";
import { toErrorPayload } from "./errors.js";

/**
 * 教学用 Shamir 门限份额 HTTP API（仅本地）。
 * 默认端口 0 = 让操作系统分配空闲端口；可用 --port 或环境变量 PORT 指定。
 */

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

export function createApiServer(service: ShamirService): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      // POST /schemes { secret, threshold, shareCount, demoCoefficients? }
      if (method === "POST" && path === "/schemes") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const result = service.createScheme({
          secret: String(body.secret),
          threshold: Number(body.threshold),
          shareCount: Number(body.shareCount),
          demoCoefficients: Array.isArray(body.demoCoefficients)
            ? (body.demoCoefficients as unknown[]).map(String)
            : undefined,
        });
        sendJson(res, 201, result);
        return;
      }
      // POST /schemes/import { threshold, shareCount, shares: [{x,y}] }
      if (method === "POST" && path === "/schemes/import") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const result = service.importShares({
          threshold: Number(body.threshold),
          shareCount: Number(body.shareCount),
          shares: (body.shares as { x: number; y: string }[]).map((s) => ({ x: Number(s.x), y: String(s.y) })),
        });
        sendJson(res, 201, result);
        return;
      }
      // GET /schemes
      if (method === "GET" && path === "/schemes") {
        sendJson(res, 200, { schemes: service.listSchemes() });
        return;
      }
      // GET /schemes/:id （含份额，教学用途）
      const schemeMatch = path.match(/^\/schemes\/([^/]+)$/);
      if (method === "GET" && schemeMatch) {
        sendJson(res, 200, service.getScheme(schemeMatch[1]));
        return;
      }
      // GET /schemes/:id/recoveries （恢复操作状态，不含秘密值）
      const recListMatch = path.match(/^\/schemes\/([^/]+)\/recoveries$/);
      if (method === "GET" && recListMatch) {
        sendJson(res, 200, { recoveries: service.listRecoveries(recListMatch[1]) });
        return;
      }
      // POST /schemes/:id/recover { xs?: number[] } 或 { shares: ShareEnvelope[] }
      const recoverMatch = path.match(/^\/schemes\/([^/]+)\/recover$/);
      if (method === "POST" && recoverMatch) {
        const body = (await readBody(req)) as Record<string, unknown>;
        const result = service.recover({
          schemeId: recoverMatch[1],
          xs: Array.isArray(body.xs) ? (body.xs as unknown[]).map(Number) : undefined,
          shares: Array.isArray(body.shares) ? (body.shares as never) : undefined,
        });
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { code: "NOT_FOUND", message: `未知路由：${method} ${path}` });
    } catch (err) {
      const payload = toErrorPayload(err);
      sendJson(res, payload.status, { code: payload.code, message: payload.message, details: payload.details });
    }
  });
}

export function startApi(service: ShamirService, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createApiServer(service);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, port: actual });
    });
  });
}
