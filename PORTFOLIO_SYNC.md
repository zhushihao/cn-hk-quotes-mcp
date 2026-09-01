# 持仓行情同步规范

## 架构和配置口径

Site 的 `lib/stocks.ts` 中 `PORTFOLIO_UNIVERSE` 是运行时唯一标的配置源，版本为 `2026-09-01-v4`。它生成 Site 的全量 `/api/portfolio-quotes` 快照；Cloudflare Worker 和 GitHub 行情桥只负责刷新、校验和转存，不再维护一份可供调仓编辑的名单。

桥接层保留固定的 23 个市场+完整代码校验，是防止旧 Site 或半更新响应进入 GitHub 的安全护栏，不是持仓配置。以后调仓先改 Site 的 `PORTFOLIO_UNIVERSE`，再同步更新桥接护栏和验收测试并部署 Site。后续可以把护栏生成改为构建时读取 Site 配置，以进一步消除重复维护。

唯一标识始终是 `market + code`，例如 `CN:603308`、`HK:03308` 和 `HK:09696`。任何只用纯数字的匹配都不允许，以免把应流股份和中际旭创 H 股混淆。

```text
PORTFOLIO_UNIVERSE（Site 单一运行时源）
  → /api/portfolio-quotes（23 只全量快照）
  → Cloudflare Worker/Cron（按原频率刷新）
  → GitHub Issue #1（行情桥）
  → ChatGPT 监控任务
```

## 当前 23 只行情标的

### Core（8 个正式持仓）

- `300308.SZ` 中际旭创，400 股
- `300502.SZ` 新易盛，1500 股
- `300394.SZ` 天孚通信，1800 股
- `688676.SH` 金盘科技，2000 股
- `601872.SH` 招商轮船，5000 股
- `588080.SH` 科创板50ETF，30000 份
- `09696.HK` 天齐锂业，数量待补
- `002192.SZ` 融捷股份，数量待补

### Growth（3 个正式持仓）

- `300433.SZ` 蓝思科技，3000 股
- `588170.SH` 科创半导体材料设备ETF，150000 份
- `603308.SH` 应流股份，1000 股

### Watch（10 个观察标的）

- `600096.SH` 云天化
- `605376.SH` 博迁新材
- `301183.SZ` 东田微
- `688596.SH` 正帆科技
- `09988.HK` 阿里巴巴
- `02228.HK` 晶泰控股
- `603893.SH` 瑞芯微
- `002460.SZ` 赣锋锂业
- `002240.SZ` 盛新锂能
- `002738.SZ` 中矿资源

### A/H Mapping（2 个价格映射行）

- `03308.HK` 中际旭创 H 股，`mapping_only=true`，映射至 `300308.SZ`
- `002466.SZ` 天齐锂业 A 股，`mapping_only=true`，映射至 `09696.HK`

映射行参与行情、A/H 相对强弱和折溢价比较，但不计入独立持仓、公司基本面或持仓告警。工程侧只维护 `CORE`、`GROWTH`、`WATCH` 三种 `portfolio_status`；不存在 `EXITED_WATCH`。锂矿专项是上层研究主题，不是工程侧状态。

总行情代码为 23；正式持仓证券为 11；主动行情条目为 13（11 个正式持仓加 2 个映射）。

## 字段和状态契约

Site 和桥接层保留原有行情字段，并校验以下持仓字段：

- `code`、`name`、`market`、`exchange`
- `group: Core | Growth | Watch`（旧字段，保持兼容）
- `portfolio_group: core | growth | watch | mapping`
- `portfolio_status: CORE | GROWTH | WATCH | null`
- `holding_status: ACTIVE | WATCH | MAPPING_ONLY`（技术行状态）
- `position_qty`、`is_position`
- `mapping_only`、`mapped_to`、`mapping_to`（后者是兼容别名）

Core/Growth 的正式持仓 `is_position=true`。已提供数量的持仓使用正数；`09696.HK` 和 `002192.SZ` 数量未提供时使用 `position_qty=null`，不把未知数量误写成零。Watch 和 Mapping 的 `is_position=false` 且数量为零。`03308.HK` 只能作为 `300308.SZ` 的价格映射，`002466.SZ` 只能作为 `09696.HK` 的价格映射。

行情时间语义保持不变：

- `market_status` 只有 `OPEN` 或 `CLOSED`
- 闭市后使用 `quality: CLOSED_SNAPSHOT`
- `market_data_time` 只填可以确认的真实成交/市场数据时间
- `source_update_time` 只表示供应商更新时间
- `fetch_time` 表示本系统抓取时间
- `quote_time` 只有确认是真实成交时间时填写，否则为 `null`
- `freshness_basis` 必须说明采用的时间依据

不得把收盘后的供应商更新时间冒充最后成交时间，也不得把港股正常公开延迟、A 股上一交易日收盘快照误判为失败。

## ETF 和市场适配

`588080.SH` 与 `588170.SH` 使用完整的 SH 市场标识，并经过腾讯、 新浪、 东方财富适配器；它们必须返回最新价、昨收、涨跌幅、成交额/成交量、日高、日低和收盘状态。ETF 不能因为证券类型不同而走普通股票失败分支。`09696.HK` 需要走港股适配器；`002192.SZ`、`002466.SZ`、`002460.SZ`、`002240.SZ`、`002738.SZ` 需要走深市适配器。

## Worker 和 GitHub 行情桥

Cloudflare Worker 继续使用 `wrangler.jsonc` 中已有的 Cron 表达式，不修改调度频率或时间语义。Worker 读取 Site 的 23 只全量响应，验证通过后更新 GitHub `zhushihao/cn-hk-quotes-mcp` 的 Issue #1；任一 Watch 没有持仓不能成为删除它的理由。

GitHub Actions 的 `workflow_dispatch` 只用于手工补跑，和 Worker 使用相同的字段及 23 只护栏。上游失败时沿用上一份成功快照并记录失败状态，不伪造行情。

## 验收清单

验收必须实际调用：

1. Site `/api/portfolio-quotes`，确认 23/23 和 Core 8、Growth 3、Watch 10、Mapping 2。
2. `/api/quote?code=` 单股接口，至少覆盖 `300308`、`03308`、`300394`、`588080`、`588170`、`601872`、`603308`、`605376`、`09696`、`002192`、`002466`。
3. Cloudflare Worker 的一次手工刷新或等价计划事件，确认读取 Site 并写桥。
4. GitHub Issue #1 最新正文，确认 23 个 `market:code` 都存在，且版本为 `2026-09-01-v4`。

最终报告必须列出三种工程状态、两个映射行、正式持仓 11，以及没有 Exited Watch。
