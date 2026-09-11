# 持仓行情同步规范

## 真相源与消费边界

正式持仓的唯一真相源是 LIVE QMT broker POSITION。LIVE 仅查询本账户实际具备的 `STOCK + HUGANGTONG`，生成内部 Portfolio Manifest；离开 LIVE 边界前再投影成 `quote-universe/1`。

`quote-universe/1` 是严格 code-only 契约：只允许 `market / exchange / code`，不允许账号、余额、成本、订单、持仓数量、研究 bucket 或本机路径。唯一标识始终是 `market + code`，不能只按纯数字代码匹配。

```text
LIVE QMT POSITION
  → Internal Portfolio Manifest（LIVE 内部，可含数量）
  → quote-universe/1（code-only + sha256）
  → Cloudflare KV：PORTFOLIO_UNIVERSE（LKG）
  → Cloudflare MCP / 动态行情投影
       ├─ LIVE ACTIVE
       ├─ Watch
       └─ A/H Mapping
```

GitHub 不再是持仓运行态真相源。本仓现有 Cron → GitHub Issue #1 仅作为旧行情桥兼容链保留，不读取 `PORTFOLIO_UNIVERSE`，因此不会因为本次改造新增实时持仓披露。

## `quote-universe/1`

示例：

```json
{
  "schema_version": "quote-universe/1",
  "as_of": "2026-09-11T16:00:00+08:00",
  "content_hash": "sha256:<64 lowercase hex>",
  "active": [
    {"market": "CN", "exchange": "SZ", "code": "300308"},
    {"market": "HK", "exchange": "HK", "code": "09696"}
  ]
}
```

规则：

- `active` 按 `market + code` 唯一，重复直接拒绝。
- `content_hash` 对规范化后的 `active` 集合计算 SHA-256；hash 不匹配不得覆盖 KV LKG。
- `as_of` 必须是可解析时间；默认超过 10 天视为陈旧并 fail-closed，兼容周末与长假但不允许无限期沿用旧持仓。
- KV 当前值只在整份 payload 通过校验后更新，因此非法上传不会破坏上一份 LKG。
- Cloudflare 对外行情投影中的真实持仓数量统一置为 `null`；数量只留在 LIVE 内部 Manifest。

## 动态消费语义

Cloudflare 先验证上游行情快照自身结构，再将 KV 中的 LIVE active set 套到行情目录：

- LIVE 已持有且行情目录已有代码：`holding_status=ACTIVE`、`is_position=true`。
- 原 Watch 后来买入：研究 bucket 仍可保持 `WATCH`，但技术持仓状态升级为 `ACTIVE`；研究分类与是否持仓完全解耦。
- 原 Core/Growth 已卖出：在 LIVE 完整快照确认后从 active 投影删除。
- Mapping 行始终只是行情映射，不能被误判成独立持仓。
- 任一 LIVE active 代码在行情目录不存在：整次动态消费 `fail-closed`，不能静默漏掉新持仓。

最后一条意味着：Cloudflare MCP 已经可以动态消费“现有行情目录覆盖到的”持仓；要做到买入一个此前从未在行情目录出现的代码也能立刻报价，上游 `cn-hk-quotes-proxy` 还需要进一步支持任意动态 code 拉取。

## Worker 接口

- MCP `get_portfolio_quotes`：有 KV LKG 时自动使用 LIVE 动态投影；KV 尚未初始化时保持旧行情目录行为，便于无中断迁移。
- `POST /api/quote-universe`：预留给受鉴权 publisher；需要 `PORTFOLIO_UNIVERSE_TOKEN` secret，未配置时始终拒绝。
- `GET /api/quote-universe`：同样需要 bearer token，用于受控诊断，不开放匿名读取真实 active set。
- `GET /api/portfolio-quotes`：同样需要 bearer token，返回动态投影，避免新增一个匿名真实持仓接口。

Cloudflare KV binding `PORTFOLIO_UNIVERSE` 由 `wrangler.jsonc` 声明；Workers Builds 部署时可自动 provision。生产写入更推荐 LIVE publisher 直接用受限 Cloudflare API token 写 KV，而不是把 GitHub 作为中转站。

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
6. KV payload hash 错误、重复代码、非法字段、过期 `as_of` 均 fail-closed。
7. 原 MCP/Worker 编译、单测和旧 Cron 链不出现回归。
