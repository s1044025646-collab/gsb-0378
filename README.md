# 教学用 Shamir 门限份额服务（GF(65537)）

一个**纯教学**的 Shamir 门限分享后端：把一个 `0..65536` 的整数拆成 `n` 份，
任意 `t` 个不同份额即可通过 Lagrange 零点插值恢复原值。
只提供 HTTP API 与 CLI，无前端、无 Docker、无外部在线服务。

> **教学限制（务必阅读）**
> - 只做整数门限分享演示：素数域固定 `p = 65537`，秘密范围 `0..p-1`，门限 `2 ≤ t ≤ n ≤ 10`。
> - **不是**生产密码系统：不做文件加密、账户登录、密钥轮换、数字签名或真实凭据保管。
> - 多于 `t` 个份额时的核对只是**冗余一致性检查**：恰好 `t` 个被改动的点仍会恢复出另一个值，
>   本方案**不提供篡改认证**，也不做自动纠错。
> - 不足门限时接口直接拒绝——这是接口约束，**不代表**任何猜测值被证明错误。

## 运行环境

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，无原生编译依赖；开发环境为 Node 25）。
- 依赖仅 `typescript` 与 `@types/node`（开发依赖）。

## 常用命令

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API（默认端口 0 = 自动选择空闲端口）
npm run demo       # 复现手算例子：secret=1234, t=2, a1=5
```

指定端口与数据目录：

```powershell
node dist/cli.js serve --port 8080 --db data\shamir.db
```

## CLI 一览

```powershell
node dist/cli.js create --secret 1234 --t 2 --n 3                     # 随机系数
node dist/cli.js create --secret 1234 --t 2 --n 3 --demo-coeffs 1234,5 # 演示模式（固定系数）
node dist/cli.js import --t 2 --n 3 --shares 1:1239,2:1244,3:1249     # 导入演示份额
node dist/cli.js recover --scheme <ID> --xs 1,2                       # 选子集恢复（含计算过程）
node dist/cli.js list                                                 # 列出方案
node dist/cli.js show --scheme <ID>                                   # 查看方案与份额
node dist/cli.js export --scheme <ID> --out shares.json               # 导出
node dist/cli.js demo                                                 # 完整手算演示
```

## HTTP API（仅监听 127.0.0.1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/schemes` | 建立方案：`{secret, threshold, shareCount, demoCoefficients?}` |
| POST | `/schemes/import` | 导入演示份额：`{threshold, shareCount, shares:[{x,y}]}` |
| GET | `/schemes` | 列出方案公共参数 |
| GET | `/schemes/:id` | 查看方案与教学份额 |
| POST | `/schemes/:id/recover` | 恢复：`{xs:[1,2]}` 或 `{shares:[...]}`，返回秘密与完整插值过程 |
| GET | `/schemes/:id/recoveries` | 恢复操作状态记录（不含秘密值） |

错误响应统一为 `{code, message, details?}`，错误码见 `src/errors.ts`
（如 `INSUFFICIENT_SHARES`、`DUPLICATE_X`、`X_OUT_OF_RANGE`、`Y_OUT_OF_RANGE`、
`SCHEME_MISMATCH`、`CONFLICTING_SHARES`、`NOT_INVERTIBLE` 等）。

## 恢复过程展示

`recover` 返回 `trace`：所选横坐标、每个点的 Lagrange 基系数 `λ_i`、域内贡献 `λ_i·y_i mod p`，
以及求和后的规范整数。提交多于 `t` 个份额时，按横坐标排序取前 `t` 个构造多项式
（输入顺序不影响选点与结果），其余点逐一核对是否落在同一多项式上，不一致则拒绝并指出冲突横坐标。

## 持久化内容（SQLite，默认 `data/shamir.db`）

- `schemes`：方案编号、参数版本、素数、门限 `t`、份数 `n`、模式（random/demo）、创建时间。
- `shares`：教学份额 `(x, y)`，与方案同事务原子写入——失败不会留下少于 `n` 个却标为成功的集合。
- `recoveries`：恢复操作状态（成功/失败、使用的横坐标、说明），**不含**恢复出的值。
- **绝不保存**：原秘密、随机系数、恢复出的秘密；常规日志也不打印这些字段。
- 服务重启后仅凭库中份额即可恢复（恢复完全由插值计算，不查库"偷看"原秘密——库里本来就没有）。

## 演示夹具

`fixtures/demo-1234.json`：`secret=1234, t=2, n=3, 系数 [1234, 5]`，份额为
`(1,1239) (2,1244) (3,1249)`，任取两个恢复 `1234`。
手算核对（`x=1,2`）：`λ1 = (0-2)/(1-2) = 2`，`λ2 = (0-1)/(2-1) ≡ 65536`，
`2·1239 + 65536·1244 ≡ 2478 + 64293 ≡ 1234 (mod 65537)`。

## 实现要点

- `src/field.ts`：BigInt 模运算（规范化为 `0..p-1`，正确处理负数）、扩展欧几里得、
  模逆（`a ≡ 0` 时抛错，绝不用普通除法替代）。
- `src/random.ts`：系统随机源 + 拒绝采样，避免取模偏差；零系数合法，不强制最高次非零。
- `src/shamir.ts`：域内多项式求值（Horner）与 Lagrange 零点插值，返回完整计算轨迹。
- `src/service.ts`：参数与份额元信息校验（方案编号、版本、素数、门限）、选点规则、冗余一致性核对。
- `src/store.ts`：SQLite 持久化与原子写入。
- `src/api.ts` / `src/cli.ts`：HTTP API 与命令行。

## 测试

`npm test` 覆盖：手算模逆（`2⁻¹ ≡ 32769`）、模减法为负、秘密 `0` 与 `p-1`、零系数、
不同门限下枚举所有大小为 `t` 的子集、重复/零/越界横坐标、越界纵坐标、混用方案、
额外冲突份额、份额不足、原子写入、重启后恢复、导入演示份额。
