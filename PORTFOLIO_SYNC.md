# 持仓行情同步规范

## 真相源与消费边界

正式持仓的唯一真相源是 LIVE QMT broker POSITION。LIVE 仅查询本账户实际具备的 `STOCK + HUGANGTONG`，生成内部 Portfolio Manifest；离开 LIVE 边界前再投影成 `quote-universe/1`。

`quote-universe/1` 是严格 code-only 契约：只允许 `market / exchange / code`，不允许账号、余额、成本、订单、持仓数量、研究 bucket 或本机路径。唯一标识始终是 `market + code`，不能只按纯数字代码匹配。

```text
LIVE QMT POSITION
  → Internal Portfolio Manifest（LIVE 内部，可含数量）
  → quote-universe/1（code-only + sha256）
  → Cloudflare Worker（使用现有 GitHub 登录身份验证，无 Cloudflare 凭据）
  → Cloudflare KV：PORTFOLIO_UNIVERSE（LKG）
  → Cloudflare MCP / 动态行情投影
       ├─ LIVE ACTIVE
       ├─ Watch
       └─ A/H Mapping
```

GitHub 不是持仓真相源、也不是行情源；它只承担**私有控制面传输**。LIVE 只向
Worker 发送 code-only 投影，并携带 LIVE 机器现有 `gh auth` token 作为身份凭证。
Worker 实时向 GitHub 校验 login=`zhushihao` 且该 token 对私有
`zhushihao/quantpro-qmt` 具有写权限，验证通过才允许写 KV。token 不保存于
Cloudflare KV、仓库或日志。PUBLIC `quantpro-collector` 不保存真实 LIVE universe。
本仓现有 Cron → GitHub Issue #1 仅作为旧行情桥兼容链保留，不注入 LIVE active set。

## `quote-universe/1`

示例：

```json
{
  "schema_version": "quote-universe/1",
  "generated_at": "2026-09-11T16:00:00+08:00",
  "source_manifest_hash": "sha256:<internal manifest hash>",
  "active": [
    {"market": "CN", "exchange": "SZ", "code": "300308"},
    {"market": "HK", "exchange": "HK", "code": "09696"}
  ],
  "content_hash": "sha256:<projection hash>"
}
```

规则：

- `active` 按 `market + code` 唯一，重复直接拒绝。
- `content_hash` 对规范化后的 `active` 集合计算 SHA-256；hash 不匹配不得覆盖 KV LKG。
- `generated_at` 必须是可解析时间；默认超过 10 天视为陈旧并 fail-closed，兼容周末与长假但不允许无限期沿用旧持仓。
- SHA-256 规范化与 `quantpro-qmt/pipeline/portfolio/projection.py` 字节级一致；Cloudflare 有固定跨语言 hash 测试，避免两端各自“自洽但互不兼容”。
- KV 当前值只在整份 payload 通过校验后更新，因此非法上传不会破坏上一份 LKG。
- Cloudflare 对外行情投影中的真实持仓数量统一置为 `null`；数量只留在 LIVE 内部 Manifest。

## `portfolio-status/1` 与三态消费

`quote-universe/1` 是精确键集合契约、且只表达「代码宇宙」；账户是否处于
「真实完整确认」状态另立私域状态件 `portfolio-status/1`（KV key
`live-portfolio/status`，与 `live-portfolio/current` 平级、同 binding）：

```json
{
  "schema_version": "portfolio-status/1",
  "generated_at": "2026-09-14T09:31:00+08:00",
  "state": "LIVE_COMPLETE",
  "last_real_complete_confirmed_at": "2026-09-14T09:30:02+08:00",
  "universe_content_hash": "sha256:<projection hash>",
  "source_manifest_hash": "sha256:<internal manifest hash>"
}
```

规则：

- 顶层为**精确六键**（多一少一皆拒）；`state` 恰三值
  `LIVE_COMPLETE` / `LKG_VALID` / `PORTFOLIO_UNKNOWN`；两个 hash 为
  `sha256:<64 位小写 hex>`。禁止 qty / name / bucket / account / orders / 本机路径。
- `last_real_complete_confirmed_at`（LRCCA）在 LIVE 侧就是 build 状态文件的
  `last_success_at`：仅「快照 ONLINE + `positions_complete=true` + 未过期 +
  identity 全解析 + 删除门通过」的 SUCCESS 轮次推进；FAIL / OFFLINE /
  缓存读取一律不推进（hash 未变但确认成功同样推进）。
- 三态阈值（自然日）：LRCCA ≤24h → `LIVE_COMPLETE`；≤10×86400s（第 10 天含当日）
  → `LKG_VALID`；超期或从未建立基线 → `PORTFOLIO_UNKNOWN`。
  `active=[]` 的完整确认是合法的 `LIVE_COMPLETE`/`LKG_VALID`（真实空仓 ≠ 未知）。
- LIVE 是三态的权威计算方；Worker 用状态件携带的 LRCCA 按同一规则**复核**，
  与自述态不一致时取更保守态（保守序：`PORTFOLIO_UNKNOWN` > `LKG_VALID` >
  `LIVE_COMPLETE`）。状态件与 universe 的 hash 交叉不一致时按瞬时态保守呈现
  （最高 LKG_VALID），不判故障。
- 消费口径：`LIVE_COMPLETE` 正常供应 overlay；`LKG_VALID` 期间**继续供应**并于
  `control_plane_status` 标记 `stale=true`；`PORTFOLIO_UNKNOWN` 期间**不应用**
  LIVE overlay，回退静态目录 legacy 行为且不报错——「未知」不得伪称「当前持仓」。
- 新鲜度锚双轨（分批上线安全）：LRCCA 优先，状态件缺失 / 不可读 / LRCCA 为空时
  回退 `generated_at` 锚并在 `control_plane_status` 记 `freshness_anchor_fallback=true`。
- 状态件写入遵循同一 LKG 语义：整件通过校验才覆盖 KV，非法件拒写且旧件保留。
  生产顺序为 universe → status；状态件端点未部署时返回 404，LIVE 侧必须容忍 404
  且不影响 universe 发布结果与退出码。

## 动态消费语义

Cloudflare 先验证上游行情快照自身结构，再将 KV 中的 LIVE active set 套到行情目录：

- LIVE 已持有且行情目录已有代码：`holding_status=ACTIVE`、`is_position=true`。
- 原 Watch 后来买入：研究 bucket 仍可保持 `WATCH`，但技术持仓状态升级为 `ACTIVE`；研究分类与是否持仓完全解耦。
- 原 Core/Growth 已卖出：在 LIVE 完整快照确认后从 active 投影删除。
- Mapping 行始终只是行情映射，不能被误判成独立持仓。
- 任一 LIVE active 代码在行情目录不存在：整次动态消费 `fail-closed`，不能静默漏掉新持仓。

最后一条意味着：Cloudflare MCP 已经可以动态消费“现有行情目录覆盖到的”持仓；要做到买入一个此前从未在行情目录出现的代码也能立刻报价，上游 `cn-hk-quotes-proxy` 还需要进一步支持任意动态 code 拉取。

## LIVE 叠加的调用方鉴权门（issue #15 D-1 + issue #8 `market:read`）

LIVE 叠加（读 KV `live-portfolio/current`、coverage 对账、`holding_status=ACTIVE`
标记、`portfolio_version=live:<content_hash>`）只对正式授权的外部 MCP client 生效。外部
ChatGPT / ChatGPT Automation 鉴权与内部 universe API 保护凭据是两条独立边界：

- **外部 MCP 面**：`Authorization` 必须逐字节匹配 Cloudflare secret
  `COLLECTOR_MCP_CLIENT_TOKEN`，同时服务端必须配置非空 `COLLECTOR_MCP_CLIENT_ID`，且
  `COLLECTOR_MCP_CLIENT_SCOPES` 显式包含 `market:read`。生产 identity 为
  `chatgpt-production`；secret 不写 Git、不进 Prompt、不进 tool schema、不进日志/响应。
- **内部 universe / 动态诊断面**：`POST/GET /api/quote-universe` 与
  `GET /api/portfolio-quotes` 继续只认 `PORTFOLIO_UNIVERSE_TOKEN`。外部 MCP credential
  不能调用这些内部端点；内部 token 也不能给 MCP client 解锁 LIVE overlay。
- **匿名 / 错 credential**：MCP `get_portfolio_quotes` 不读 LIVE KV、不判三态、不报鉴权错误，
  继续投影为 quote-only，并标注 `SKIPPED_UNAUTHORIZED`；不得暴露 LIVE active 集、数量、
  universe hash 或 coverage 缺失代码。
- **外部 credential 未配置**：`SKIPPED_TOKEN_NOT_CONFIGURED`，fail-closed；
  credential 正确但缺 `market:read`：`SKIPPED_INSUFFICIENT_SCOPE`，fail-closed；
  缺 production client identity 也按未授权 fail-closed。
- **外部 credential + identity + `market:read` 全部通过**：`ENABLED`。随后是否实际叠加仍由
  既有三态、freshness 与 coverage gate 决定；coverage 缺失仍硬失败，三态未知 / 锚不新鲜
  仍按 J-11/C-5 保守处理。issue #8 不修改 LIVE/QMT 持仓生成逻辑。

### `control_plane_status.live_overlay_status` 与脱敏鉴权审计

`get_portfolio_quotes` 与 `get_control_plane_status` 都返回 `live_overlay_status`：

| 取值 | 含义 |
|------|------|
| `ENABLED` | 外部 client credential、production identity 与 `market:read` 均通过；后续仍受三态 / freshness / coverage 约束 |
| `SKIPPED_UNAUTHORIZED` | 匿名、credential 错误，或缺 production client identity → quote-only |
| `SKIPPED_TOKEN_NOT_CONFIGURED` | 服务端未配置外部 `COLLECTOR_MCP_CLIENT_TOKEN` → fail-closed |
| `SKIPPED_INSUFFICIENT_SCOPE` | credential 正确但未授予 `market:read` → fail-closed |

MCP 控制面同时带 `market_read_auth` 脱敏审计块，只允许出现认证模式、是否通过、批准的
client identity 与 scope；未授权时 `client_id=null`、`scopes=[]`。任何 bearer/secret 值都不得
进入该块或结构化日志。`mode` 仍描述 KV/控制面形态，不代表本次调用是否获得 LIVE overlay；
匿名典型形态仍是 `mode=LIVE_DYNAMIC` + `live_overlay_status=SKIPPED_UNAUTHORIZED`。

### 错误文本不含证券代码

所有面向调用方的错误 / 提示文本一律不含证券代码（coverage 缺失、identity、stale 等
同规则），**缺失数量保留**：旧文本 `upstream quote catalog is missing LIVE positions:
CN:002409, CN:002975` 已改为 `upstream quote catalog is missing 2 LIVE positions`。
经出口统一去码（`src/live-overlay.ts` 的 `redactInstrumentCodes()`：`CN:002409` 形态与
裸 5–6 位代码 → `[REDACTED_CODE]`；`sha256:<hex>`、`age=864000s` 等不受影响）。
逐代码明细只进服务端结构化日志（`live_universe_coverage_incomplete` 事件），不出现在
任何响应体里。

## Worker 接口

- MCP `get_portfolio_quotes`：正式外部 client credential + `chatgpt-production` identity + `market:read` 才可消费 LIVE KV；匿名/未授权继续 quote-only。
- `POST /api/github-auth/probe`：仅验证 GitHub 登录身份和私有仓写权限，不写 KV，用于无副作用链路验收。
- `POST /api/github-auth/quote-universe`：仅接受通过 GitHub 实时身份校验的 LIVE 请求，并严格验证 `quote-universe/1` 后写 KV。
- `POST /api/github-auth/portfolio-status`：同样仅接受 GitHub 实时身份校验的 LIVE 请求，严格验证 `portfolio-status/1`（精确六键）后写 KV key `live-portfolio/status`；失败语义与 universe 端点一致（401 / 413 / 400），非法件拒写且不破坏旧件。
- `GET /api/control-plane-status`：只返回 KV binding、universe 是否存在/新鲜、`GITHUB_VERIFIED_PUSH` 模式，以及 `portfolio_state` 三态枚举（附 `stale` 与双轨锚留痕）；不返回代码、数量或 hash。
- Cron：继续只跑旧公开行情桥；LIVE universe 由 OIDC push 独立更新，失败不会破坏 KV LKG。
- `POST /api/quote-universe`：旧直推入口保留但不是生产路径；仍只认内部 `PORTFOLIO_UNIVERSE_TOKEN`。
- `GET /api/quote-universe`：同样只认内部 token，用于受控诊断，不开放匿名读取真实 active set。
- `GET /api/portfolio-quotes`：同样只认内部 token，返回动态投影；外部 MCP credential 不可替代内部 token。

Cloudflare KV binding `PORTFOLIO_UNIVERSE` 由 `wrangler.jsonc` 声明；Workers Builds 部署时可自动 provision。生产链不要求 LIVE 保存 Cloudflare Account ID / Namespace ID / API Token。

## 与旧桥的兼容

原 Site/Proxy 的行情字段和 Watch/Mapping 目录暂时继续使用；本轮只取消 Cloudflare 桥里的固定 `portfolio_version=2026-09-01-v4`、固定 23 个代码、固定 13 个 active 等持仓护栏。

现有 Cloudflare Cron 时间不变；现有 GitHub Issue #1 和 `workflow_dispatch` 暂不切换到 LIVE KV，以免公开仓在迁移阶段承载实时持仓。

## 验收

至少验证：

1. 动态 validator 接受新增代码，不依赖固定 23/13 或固定版本号。
2. Watch 标的被 LIVE 买入后可成为 `ACTIVE`，同时保持 `portfolio_status=WATCH`。
3. LIVE active 缺行情时 coverage gate 拒绝输出，而不是静默遗漏。
4. 卖出标的从 active 投影消失；Mapping 仍保留。
5. Cloudflare 边界没有持仓数量泄漏。
6. KV payload hash 错误、重复代码、非法字段、过期 `generated_at` 均 fail-closed。
7. LIVE 使用现有 GitHub 登录态调用 auth probe 成功；PUBLIC 仓无 LIVE universe 文件。
8. 原 MCP/Worker 编译、单测和旧 Cron 链不出现回归。
9. `portfolio-status/1` 精确六键、三态边界（恰 24h / 恰 10 天 / 超 1 秒 / 无基线）、
   J-4 保守复核、双轨锚两形态，以及 `stale`/`portfolio_state` 消费口径均由
   `tests/portfolio-status.test.mjs` 与 `tests/live-universe.test.mjs` 锁定。
10. D-1 / issue #8 口径由 `tests/live-overlay.test.mjs` 与隐私 wiring 测试锁定：匿名不叠加 / 不报错 / 无代码与
   数量泄漏；外部 client credential 与内部 universe token 不可互相授权；缺 token / identity /
   `market:read` 均 fail-closed；coverage 缺失仍 fail-closed；`live_overlay_status` 四值。
