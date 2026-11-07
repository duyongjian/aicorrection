# 线下分发 MVP · 卡密与账号

> 目标：让道源能**立刻把产品发给真人试用**。卡密即账号，兑换后自动创建既有匿名身份，
> 不引入手机号 / 邮箱 / 微信注册，不产生任何注册摩擦与外发。
>
> 文档日期：2026-11-07 · 版本：v0.1 + 离线分发增量

---

## 0. 先读这一段：定位与诚实声明

**这是一个「线下内测体验版」，不是已验收产品。**

| 项 | 状态 |
|---|---|
| 可用性 | ✅ 可构建、可单端口启动、可发卡、可激活、可停用、可跑通五步闭环 |
| 账号 / 卡密 | ✅ 已实现（本次增量） |
| 归因质量 | ⚠️ **尚未通过正式验收**。G1 闸门仍为 `OPEN BLOCKER / NO-GO` |
| 正式人工盲评 | ❌ 未做（按授权：不再以「50–100 条真实学生错题 + 2 名评分人」作为分发前置） |
| 代理量 ↔ 质量相关性 | ❌ 未校准。质量量尺 `wordlist-v2.1` 只测「结构代理量的检出能力」，**命中 ≠ 质量好** |

前端激活页固定展示提示：

> 本版为线下内测版，归因质量尚未通过正式验收，请仅用于体验与反馈。

**因此分发时请明确告知试用者：这是一次体验与反馈收集，不是成品。** 收集回来的反馈
才是后续质量优化的输入，不得把内测使用数据包装成 G1 证据或正式基线。

关于质量现状的完整口径见：
- `docs/归因质量量尺A层落地.md`
- `docs/归因质量量尺B层_词表校准与深度候选AB.md`
- `docs/8093-Qwen3.8-9B-Distill深度思考档复测.md`（结论：部分改善，根因未彻底解除）

---

## 1. 设计取舍

### 1.1 卡密即账号

- 不新增手机号 / 邮箱 / 微信登录体系。现有账号本来就是匿名 `anon_user_id`，
  `accountService.ts` 明确把真实登录推到 v0.2。
- 用户在激活页输入卡密 + 选择分段，服务端兑换成功后调用既有 `createAccount({ segment })`，
  把 `anon_user_id` 与 `license_token` 一起返回。
- 前端把两者写入 `localStorage`，`loopStore` 重新读取持久化身份，
  **主流程一行业务代码都不用改**，也不会再调公开的 `POST /account`。

### 1.2 独立分发库（不碰生产库）

- `getDb()` 支持 `AICORRECTION_DB_PATH` 覆盖；未设置时完全沿用 `env.DB_PATH`。
- 分发脚本强制把库指向 `data/distribution/aicorrection-dist.db`，
  uploads 指向 `data/distribution/uploads/`。
- **绝不读写生产库**。本机实际有两个同名库，务必区分：
  `apps/api/src/data/aicorrection.db`（约 335MB，`tsx` 直跑 `src` 时 `env.DB_PATH` 的真实落点）
  与 `apps/api/data/aicorrection.db`（约 124KB 遗留小库）。
  CLI 与启动脚本共用 `dist-env.mjs` 的 `assertNotProductionDb()`，
  对 `apps/api/**/aicorrection.db` 一律拒绝写入。

### 1.3 门禁默认关闭

- 只有 `LICENSE_GATE_ENABLED=true` 才启用卡密门禁；分发脚本会强制开启。
- 开发态 / 全量单测行为**零变化**：门禁关闭时前端 `getLicenseStatus()` 返回
  `active:true, gate_enabled:false`，激活页直接放行（不会出现一张永远通不过的页面）。

### 1.4 单端口

生产态 `app.ts` 已用 `express.static(webDist)` 托管 `apps/web/dist`，
因此「构建一次 → 一个 Node 服务 → 发卡分发」即可，不需要另起前端服务器。

### 1.5 数据主权

| 约束 | 实现 |
|---|---|
| 服务端不存明文 | `license_keys` 只存 `code_hash`（SHA-256）+ 末 4 位 `code_hint`；`license_sessions` 只存 `token_hash` |
| 明文只出现一次 | 发卡 CLI 输出时 / 兑换响应时；此后任何人都无法从 DB 反查 |
| 不联网 | 卡密链路不发起任何外部请求；`WEB_SEARCH_ENABLED` 默认 false |
| 不外发、不写日志明文 | CLI 输出只到本机 stdout / 本地 CSV；服务端日志无卡密 |
| 管理面不暴露 HTTP | 发卡 / 停用 / 列表**只走本机 CLI**，没有管理接口 |
| 本地闭环 | 库、uploads、明文 CSV 全在本机；`.gitignore` 已排除分发产物 |

---

## 2. 三步上手

### 前置

```bash
cd aicorrection-v0.1
npm install              # 若已装过可跳过
```

### 第 1 步：发卡

```bash
npm run license:generate -- --count 20 --batch offline-01 --note "2026-11-07 首批试用人"
```

- 卡密形如 `AC-XXXX-XXXX-XXXX`，字母表去掉 `I/L/O/0/1` 避免肉眼混淆。
- **明文只在这里输出一次**。建议加 `--out <本地文件.csv>` 保存后立刻离线保管。
- 终端会同时打印警告：不要提交 git、不要发聊天 / 云端、不要外传。
- 可选 `--expires YYYY-MM-DD` 设置过期。

### 第 2 步：启动

```bash
npm run distribute
```

脚本会：创建分发目录 → 跑 `npm run build` → 以
`LICENSE_GATE_ENABLED=true` + 独立库 + 独立 uploads 启动 API。
启动完成后访问：

```
http://localhost:3001
```

局域网内其他人用 `http://<你的内网IP>:3001` 访问（`index.ts` 绑定 `0.0.0.0`）。
端口可用 `PORT` 环境变量覆盖。

### 第 3 步：把卡密发给试用者

一张卡密一个人；对方打开地址 → 输入卡密 → 选分段 → 点「激活」→ 进入产品。

管理动作：

```bash
npm run license:list -- --batch offline-01     # 看状态（只显示 ****-末4位）
npm run license:revoke -- --code AC-XXXX-XXXX-XXXX   # 停用，立即失去所有业务访问权
```

`list` 输出 `unused / redeemed / revoked` 三态，可用来确认哪些卡已被激活。

---

## 3. 技术契约（供排查）

### HTTP 端点

| 端点 | 凭证 | 说明 |
|---|---|---|
| `POST /api/v1/license/redeem` | 匿名 | 兑换；返回 `license_token` + `anon_user_id`，并下发图片 cookie |
| `GET /api/v1/license/status` | 匿名 | **始终 200**；失效以 `active:false + reason` 表达 |
| 其余 `/api/v1/*` 业务接口 | 必需 | 缺失返回 `401 LICENSE_REQUIRED` |
| `GET /health` | 匿名 | base 之外，运维探活 |
| `GET /api/v1/config/llm-status` | 匿名 | 在门禁之前注册，运维诊断 |
| 静态前端 | 匿名 | base 之外，未激活用户也能打开激活页 |

凭证携带：`x-license-token` 或 `Authorization: Bearer <token>`。

### 错误码

| code | 含义 |
|---|---|
| 4001 `LICENSE_REQUIRED` | 未激活 / 凭证无效 |
| 4002 `LICENSE_INVALID` | 卡密格式错误或不存在 |
| 4003 `LICENSE_ALREADY_USED` | 卡密已被激活 |
| 4004 `LICENSE_REVOKED` | 卡密已停用 |
| 4005 `LICENSE_EXPIRED` | 卡密已过期 |

前端 axios 拦截到 `401 + 4001/4004/4005` 会清掉本地凭证并回到激活页。

### 原图回显的凭证处理（一处刻意收紧）

浏览器 `<img src="/api/v1/uploads/...">` **无法携带自定义 header**，但门禁又不能
对 uploads 匿名放行。处理方式：

- 兑换成功下发 `HttpOnly` cookie，`Path=/api/v1/uploads`，`SameSite=Lax`（线下 http 不设 `secure`）。
- `requireLicense` **仅**在 `GET /uploads/*` 时额外接受该 cookie 承载同一份凭证，
  仍完整走 `verifyLicenseToken`——**不是匿名放行**。
- 业务接口只认 header，cookie 在业务接口返回 401，避免 cookie 变成全站 CSRF 凭证。
- 凭证失效时 `/license/status` 会清掉该 cookie。

> 已知限制：cookie 与 token 等价，拿到 cookie 的人可读取原图；URL 为不可枚举的
> `mistake_ref`。正式版应换成带凭证的短期签名 URL。

### DB 增量

`014_license.sql` 只 `CREATE TABLE IF NOT EXISTS` 两张表，不 ALTER 既有表、
不改写既有数据，对既有库是纯增量。迁移器按文件名顺序自动应用。

---

## 4. 分发前检查清单

- [ ] `npm run build` 通过
- [ ] `npm run test -w @aicorrection/api` 全绿
- [ ] `npx tsx scripts/license-e2e.mjs` 全绿（隔离库，不碰生产库）
- [ ] 卡密明文已离线保管，未进入 git / 聊天 / 云盘
- [ ] `data/distribution/` 已被 `.gitignore` 排除（已配置）
- [ ] 已告知试用者「内测体验版，归因质量未验收」
- [ ] 确认启动日志里的库路径是 `data/distribution/...`，不是生产库

---

## 5. 本次验证记录（2026-11-07）

| 验证 | 结果 |
|---|---|
| `npm run build`（shared + web 产物 + api typecheck） | ✅ 通过 |
| api / web `typecheck` | ✅ 通过 |
| `npm run test -w @aicorrection/api` | ✅ **95/95**（既有 75 + 新增卡密单测 20） |
| `npx tsx scripts/license-e2e.mjs`（真实 HTTP，系统 temp 隔离库） | ✅ **22/22** |
| CLI 发卡 → 另一进程真实服务激活（跨进程联合验证） | ✅ **8/8** |
| `npm run distribute` 一键脚本实测（构建→启动→首页/门禁） | ✅ **7/7** |

E2E 覆盖：未激活 401 → 兑换成功 → 带凭证业务可用 → 单端口首页可访问 →
原图仅凭 cookie 可读 → cookie 在业务接口仍 401 → 重复兑换被拒 →
停用后原 token 立即 401 → 门禁关闭后无凭证放行且 `gate_enabled=false`。

单测覆盖：卡密归一化（含裸主体以 AC 开头的回归）、发卡数量校验、重复兑换、
停用 / 过期、门禁关闭语义、无效 token / 无效卡密、hint 不含明文。
所有隔离库在系统 temp，用完清理；两个生产库 mtime 保持 11-03 未变。

---

## 6. 已知限制 / 后续

1. **质量未验收**：G1 六项门槛未解除；代理量与质量的相关性未校准；
   `v0.5-depth` 仍是离线候选，未接生产。按授权，这些放到「分发后慢慢测」。
2. 正式人工盲评（真实学生错题 + 2 名评分人）仍未做；若后续补做，
   本轮内测数据**不得**冒充正式基线或 G1 证据。
3. 卡密无法自助找回：明文丢失即无法恢复（服务端只有 hash），请自行保管清单。
4. 停用是「整卡失效」，不做设备级解绑。
5. 原图 cookie 见 §3 已知限制。
6. 无注册 / 找回 / 多设备同步；同一浏览器清掉 localStorage 后需重新激活
   （卡密已 `redeemed` 会报 4003，需发放人补发新卡）。
