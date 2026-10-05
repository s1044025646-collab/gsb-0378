# Shamir 门限份额教学后端（TypeScript / Node.js / SQLite）

把一个示例整数在素数域 **GF(65537)** 上拆成 `n` 份，持有任意 `t`（`2 ≤ t ≤ n ≤ 10`）
个不同份额即可通过 Lagrange 零点插值恢复原值。仅提供 HTTP API 与命令行（CLI），无前端。

> **教学限制（务必先读）**
>
> - 本项目只演示**整数门限秘密分享**的有限域数学，不是生产密码系统。
> - 不做文件加密、账户登录、密钥轮换、数字签名、真实凭据保管。
> - 素数仅 `p = 65537`，秘密范围 `[0, 65536]`，份额数上限 10，参数极小，无安全强度。
> - 冗余份额一致性检查**不是篡改认证**：恰好 `t` 个被改动的点仍会恢复出另一个值；
>   系统也不尝试自动纠错。
> - “份额不足恢复失败”是**接口约束**，表示信息不足以插值，**并不证明某个猜测值是错的**。

## 数学说明

- 构造：随机多项式 `f(x) = a0 + a1 x + ... + a_{t-1} x^{t-1} (mod p)`，常数项 `a0 = 秘密`，
  其余 `t-1` 个系数由系统随机源 `crypto.randomInt` 经**拒绝采样**在整个域上独立均匀抽取
  （无取模偏差）。**零系数完全合法**，不会为了让最高次数非零而改变随机分布。
  份额为 `(x, f(x))`，横坐标 `x = 1..n`，永不分配 `x=0`（0 号点即秘密本身）。
- 恢复：Lagrange 在零点插值
  `f(0) = Σ_j yj · Π_{m≠j} (0-xm)/(xj-xm) (mod p)`。
  全程 BigInt 整数模运算；除法一律用**扩展欧几里得算法**求模逆，逆元不存在时直接报错，
  绝不回退为普通实数除法。
- 计算过程会逐项展示：所选横坐标、每项基系数 `L_j(0)`、域内贡献 `yj·L_j(0) mod p`、
  模 p 求和结果（规范整数）。
- 提交多于 `t` 个份额时：先按横坐标排序选前 `t` 个构造多项式，再用模域消元插值检查其余点
  是否落在同一多项式上，冲突即拒绝并指出横坐标、期望值、实际值。**输入顺序不影响选点与结果**。
- 恢复只使用调用方提交的份额做插值，**不会从数据库查回原秘密充当输出**。

## 持久化内容（项目内 `data/` 目录）

SQLite 文件 `data/shamir.db`（含 WAL 附属文件）保存：

- `schemes`：方案公共参数（方案编号、参数版本 `shamir-gf65537-v1`、门限、份额数、是否演示模式、时间）。
- `shares`：教学份额的横坐标与纵坐标。
- `recoveries`：恢复操作**状态**（成功/拒绝、错误码、选用的横坐标）。

**默认不保存**：原秘密、随机系数、恢复出的值。常规日志也不打印这些字段。
需要留存手算样本时，用 CLI `export` **显式导出**样本 JSON 文件（自行妥善保管）。
一次份额生成在单个事务内原子提交，失败整体回滚，不会留下少于 `n` 个却标记成功的集合；
服务重启后仅凭已保存的份额即可恢复。

可用环境变量：`SHAMIR_DATA_DIR`（默认 `./data`）、`PORT`（不设则自动选择空闲端口）。

## 环境要求

- Windows 本地运行；Node.js **≥ 22.5**（本仓库在 Node 25 上验证，使用内置 `node:sqlite`，无需原生编译）。
- 不依赖 Docker、WSL、付费服务或任何外部在线 API。

## 构建、测试、启动、演示

```powershell
npm install
npm test          # 构建（tsc）并运行 node:test 全部用例
npm run build     # 仅编译到 dist/
npm start         # 启动 HTTP 服务（默认自动选空闲端口；$env:PORT="3780" 可固定）
npm run demo      # CLI 教学演示：1234/t=2/系数5、单点失败、冲突份额
```

## CLI 用法

```powershell
# 随机系数模式
node dist/cli/index.js create --secret 2024 --t 3 --n 5

# 显式演示模式（注入固定系数，必须加 --demo）
node dist/cli/index.js create --secret 1234 --t 2 --n 3 --demo --coeffs 5

# 查看方案（含份额）
node dist/cli/index.js get <schemeId>

# 选择子集恢复，份额格式为 门限:x:y，顺序任意
node dist/cli/index.js recover <schemeId> 2:3:1249 2:1:1239

# 核对额外份额：多给的点会被一致性校验
node dist/cli/index.js recover <schemeId> 2:1:1239 2:2:1244 2:3:1249

# 显式导出样本文件
node dist/cli/index.js export <schemeId> .\sample.json

# 查看恢复操作状态
node dist/cli/index.js recoveries <schemeId>
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查与参数版本 |
| `POST` | `/schemes` | 建立方案并一次性生成份额 |
| `GET` | `/schemes/{id}` | 查看方案公共参数与份额 |
| `POST` | `/schemes/{id}/recover` | 用提交的份额恢复，返回值与完整计算过程 |
| `GET` | `/schemes/{id}/recoveries` | 恢复操作状态记录 |

建立方案请求体：

```json
{ "secret": 1234, "threshold": 2, "count": 3, "demo": true, "demoCoefficients": [5] }
```

恢复请求体（横坐标顺序任意，可多给用于一致性核对）：

```json
{ "shares": [ { "threshold": 2, "x": 3, "y": 1249 }, { "threshold": 2, "x": 1, "y": 1239 } ] }
```

PowerShell 示例：

```powershell
Invoke-RestMethod http://127.0.0.1:3780/schemes -Method Post `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"secret":1234,"threshold":2,"count":3,"demo":true,"demoCoefficients":[5]}'
```

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_PARAMS` / `DEMO_REQUIRED` | 参数或 JSON 非法；注入固定系数未显式开启演示模式 |
| `SECRET_OUT_OF_RANGE` | 秘密不在 `[0, 65536]` |
| `THRESHOLD_OUT_OF_RANGE` / `SHARE_COUNT_OUT_OF_RANGE` | 门限不在 2–10 或份额数非法 |
| `THRESHOLD_EXCEEDS_COUNT` | `t > n` |
| `COEFFICIENT_OUT_OF_RANGE` | 注入系数越界 |
| `SCHEME_NOT_FOUND` | 方案编号不存在 |
| `DUPLICATE_X` / `ZERO_X` / `X_OUT_OF_RANGE` / `Y_OUT_OF_RANGE` | 份额横坐标重复 / 为 0 / 越界，纵坐标越界 |
| `SCHEME_MISMATCH` | 混用不同方案或门限/版本元信息不一致 |
| `INSUFFICIENT_SHARES` | 不同份额数量不足门限（接口约束，非对猜测值的否定） |
| `CONFLICTING_SHARE` | 额外份额与前 `t` 个点确定的多项式不一致 |

## 固定教学夹具

秘密 `1234`，`t=2`，演示系数 `a1=5`，多项式 `f(x) = 1234 + 5x`：

`(1,1239)`、`(2,1244)`、`(3,1249)`。任取两个恢复均为 `1234`，只给一个被拒绝。

## 测试覆盖

- 手算模逆：`3⁻¹ ≡ 5 (mod 7)`；GF(65537) 上 `3·3⁻¹ ≡ 1`；模逆不存在（0）时报错而非普通除法。
- 模减法为负（`0-1 ≡ p-1`）、秘密 0 与最大值 65536、零系数、门限 t=3/t=4。
- 对小 `n` 枚举所有大小为 `t` 的子集核对恢复；输入顺序打乱结果不变。
- 重复/零/越界横纵坐标、混用方案、版本元信息校验。
- 额外冲突份额检测；恰好 `t` 个被改点恢复出插值结果（证明这不是认证机制）。
- SQLite 事务原子性、重启后仅凭份额恢复、恢复状态记录不含秘密值。
