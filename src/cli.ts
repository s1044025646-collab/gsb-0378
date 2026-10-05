#!/usr/bin/env node
/**
 * 教学用 Shamir 门限份额 CLI。
 *
 * 用法：
 *   node dist/cli.js serve [--port N] [--db PATH]
 *   node dist/cli.js create --secret 1234 --t 2 --n 3 [--demo-coeffs 1234,5] [--db PATH]
 *   node dist/cli.js import --t 2 --n 3 --shares 1:1239,2:1244,3:1249 [--db PATH]
 *   node dist/cli.js recover --scheme ID [--xs 1,3] [--db PATH]
 *   node dist/cli.js list [--db PATH]
 *   node dist/cli.js show --scheme ID [--db PATH]
 *   node dist/cli.js export --scheme ID [--out FILE] [--db PATH]
 *   node dist/cli.js demo [--db PATH]   复现 secret=1234, t=2, a1=5 的手算例子
 */
import { writeFileSync } from "node:fs";
import { Store, defaultDbPath } from "./store.js";
import { ShamirService } from "./service.js";
import { startApi } from "./api.js";
import { toErrorPayload } from "./errors.js";

interface Args {
  command: string;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return { command, flags };
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(err: unknown): never {
  const payload = toErrorPayload(err);
  process.stderr.write(`错误 [${payload.code}] ${payload.message}\n`);
  process.exit(1);
}

function getService(dbFlag?: string): { service: ShamirService; store: Store } {
  const store = new Store(dbFlag ?? defaultDbPath());
  return { service: new ShamirService(store), store };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const db = flags.get("db");

  switch (command) {
    case "serve": {
      const port = flags.has("port") ? Number(flags.get("port")) : Number(process.env.PORT ?? 0);
      const { service, store } = getService(db);
      const { port: actual } = await startApi(service, port);
      process.stdout.write(`API 已启动：http://127.0.0.1:${actual} （数据库：${db ?? defaultDbPath()}）\n`);
      const shutdown = () => {
        store.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      break;
    }
    case "create": {
      const { service, store } = getService(db);
      try {
        const demoCoeffs = flags.get("demo-coeffs");
        const result = service.createScheme({
          secret: flags.get("secret") ?? "",
          threshold: Number(flags.get("t")),
          shareCount: Number(flags.get("n")),
          demoCoefficients: demoCoeffs ? demoCoeffs.split(",").map((s) => s.trim()) : undefined,
        });
        printJson(result);
      } catch (err) {
        fail(err);
      } finally {
        store.close();
      }
      break;
    }
    case "import": {
      const { service, store } = getService(db);
      try {
        const sharesArg = flags.get("shares") ?? "";
        const shares = sharesArg
          .split(",")
          .filter(Boolean)
          .map((pair) => {
            const [x, y] = pair.split(":");
            return { x: Number(x), y };
          });
        printJson(
          service.importShares({
            threshold: Number(flags.get("t")),
            shareCount: Number(flags.get("n")),
            shares,
          })
        );
      } catch (err) {
        fail(err);
      } finally {
        store.close();
      }
      break;
    }
    case "recover": {
      const { service, store } = getService(db);
      try {
        const xs = flags.get("xs");
        const result = service.recover({
          schemeId: flags.get("scheme") ?? "",
          xs: xs ? xs.split(",").map((s) => Number(s.trim())) : undefined,
        });
        printJson(result);
      } catch (err) {
        fail(err);
      } finally {
        store.close();
      }
      break;
    }
    case "list": {
      const { service, store } = getService(db);
      printJson({ schemes: service.listSchemes() });
      store.close();
      break;
    }
    case "show": {
      const { service, store } = getService(db);
      try {
        printJson(service.getScheme(flags.get("scheme") ?? ""));
      } catch (err) {
        fail(err);
      } finally {
        store.close();
      }
      break;
    }
    case "export": {
      const { service, store } = getService(db);
      try {
        const data = service.getScheme(flags.get("scheme") ?? "");
        const json = JSON.stringify(data, null, 2);
        const out = flags.get("out");
        if (out) {
          writeFileSync(out, json, "utf8");
          process.stdout.write(`已导出到 ${out}\n`);
        } else {
          process.stdout.write(json + "\n");
        }
      } catch (err) {
        fail(err);
      } finally {
        store.close();
      }
      break;
    }
    case "demo": {
      // 手算复现：secret=1234, t=2, a1=5, p=65537 → (1,1239) (2,1244) (3,1249)
      const { service, store } = getService(db);
      try {
        const created = service.createScheme({
          secret: "1234",
          threshold: 2,
          shareCount: 3,
          demoCoefficients: ["1234", "5"],
        });
        process.stdout.write("演示方案（secret=1234, t=2, a1=5, p=65537）：\n");
        printJson(created.shares);
        const id = created.scheme.schemeId;
        for (const xs of [
          [1, 2],
          [1, 3],
          [2, 3],
        ]) {
          const r = service.recover({ schemeId: id, xs });
          process.stdout.write(`用 x=${xs.join(",")} 恢复 → secret=${r.secret}\n`);
        }
        // 三个份额一起提交，演示冗余一致性核对
        const r3 = service.recover({ schemeId: id, xs: [1, 2, 3] });
        process.stdout.write(`用 x=1,2,3 恢复 → secret=${r3.secret}，额外份额核对：${JSON.stringify(r3.consistency)}\n`);
        // 只给一个份额：应失败
        try {
          service.recover({ schemeId: id, xs: [1] });
        } catch (err) {
          const p = toErrorPayload(err);
          process.stdout.write(`只给 1 个份额 → 预期失败 [${p.code}] ${p.message}\n`);
        }
      } finally {
        store.close();
      }
      break;
    }
    default: {
      process.stdout.write(
        [
          "教学用 Shamir 门限份额 CLI（p=65537，仅整数演示）",
          "命令：serve | create | import | recover | list | show | export | demo",
          "示例：",
          "  node dist/cli.js demo",
          "  node dist/cli.js create --secret 1234 --t 2 --n 3",
          "  node dist/cli.js recover --scheme <ID> --xs 1,2",
          "  node dist/cli.js serve --port 8080",
        ].join("\n") + "\n"
      );
    }
  }
}

main().catch(fail);
