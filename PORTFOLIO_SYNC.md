# 持仓行情同步规范

## 架构和配置口径

Site 的 `lib/stocks.ts` 中 `PORTFOLIO_UNIVERSE` 是运行时唯一标的配置源。它生成 Site 的全量 `/api/portfolio-quotes` 快照；Cloudflare Worker 和 GitHub 行情桥只负责刷新、校验和转存，不再维护一份可供调仓编辑的名单。

桥接层保留固定的 17 个市场+完整代码校验，是防止旧 Site 或半更新响应进入 GitHub 的安全护栏，不是持仓配置。以后调仓仍应先改 Site 的 `PORTFOLIO_UNIVERSE`，再同步部署 Site；如果标的数量或代码发生变化，需要同时更新桥接护栏和验收测试。

唯一标识始终是 `market + code`，例如 `CN:603308` 和 `HK:03308`。任何只用纯数字的匹配都不允许，以免把应流股份和中际旭创 H 股混淆。

```text
PORTFOLIO_UNIVERSE（Site 单一运行时源）
  → /api/portfolio-quotes（17 只全量快照）
  → Cloudflare Worker/Cron（按原频率刷新）
  → GitHub Issue #1（行情桥）
  → ChatGPT 监控任务
```

## 当前 17 只标的

### Core（6）

正式持仓：

- `300308.SZ` 中际旭创，400 股
- `300502.SZ` 新易盛，1500 股
- `300394.SZ` 天孚通信，1800 股
- `688676.SH` 金盘科技，2000 股
- `601872.SH` 招商轮船，5000 股
- `588080.SH` 科创板50ETF，30000 份

H 股价格映射单列：

- `03308.HK` 中际旭创 H 股，`MAPPING_ONLY`，`mapping_to: 300308.SZ`，不计入正式持仓

### Growth（3）

- `300433.SZ` 蓝思科技，3000 股
- `588170.SH` 科创半导体材料设备ETF，150000 份
- `603308.SH` 应流股份，1000 股

### Watch（4）

- `600096.SH` 云天化
- `09988.HK` 阿里巴巴
- `02228.HK` 晶泰控股
- `603893.SH` 瑞芯微

### Exited Watch（3）

下面标的已经退出正式持仓，但仍必须返回行情：

- `605376.SH` 博迁新材
- `301183.SZ` 东田微
- `688596.SH` 正帆科技

总行情代码为 17；正式持仓证券为 9；加上 H 股映射后的主动行情条目为 10。

## 字段和状态契约

Site 和桥接层保留原有行情字段，并新增或校验以下持仓字段：

- `code`、`name`、`market`、`exchange`
- `group: Core | Growth | Watch`（旧字段，保持兼容）
- `portfolio_group: core | growth | watch | exited_watch | mapping`（新规范字段）
- `holding_status: ACTIVE | WATCH | EXITED | MAPPING_ONLY`
- `position_qty`、`is_position`、`mapping_to`

Core/Growth 的正式持仓 `is_position=true` 且数量大于零；Watch、Exited Watch 和 H 股 Mapping 的 `is_position=false` 且数量为零。`03308.HK` 只能作为 `300308.SZ` 的价格映射，不能被算作独立持仓。`601872.SH` 是 Core 的 `ACTIVE`，不能再标记为 `EXITED` 或 Watch。

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

`588080.SH` 与 `588170.SH` 使用完整的 SH 市场标识，并经过腾讯、 新浪、 东方财富适配器；它们必须返回最新价、昨收、涨跌幅、成交额/成交量、日高、日低和收盘状态。ETF 不能因为证券类型不同而走普通股票失败分支。

## Worker 和 GitHub 行情桥

Cloudflare Worker 继续使用 `wrangler.jsonc` 中已有的 Cron 表达式，不修改调度频率或时间语义。Worker 读取 Site 的 17 只全量响应，验证通过后更新 GitHub `zhushihao/cn-hk-quotes-mcp` 的 Issue #1；任一 Watch 或 Exited Watch 没有持仓不能成为删除它的理由。

GitHub Actions 的 `workflow_dispatch` 只用于手工补跑，和 Worker 使用相同的字段及 17 只护栏。上游失败时沿用上一份成功快照并记录失败状态，不伪造行情。

## 验收清单

验收必须实际调用：

1. Site `/api/portfolio-quotes`，确认 17/17 和五层数量。
2. `/api/quote?code=` 单股接口，至少覆盖 `300308`、`03308`、`300394`、`588080`、`588170`、`601872`、`603308`、`605376`。
3. Cloudflare Worker 的一次手工刷新或等价计划事件，确认读取 Site 并写桥。
4. GitHub Issue #1 最新正文，确认 17 个 `market:code` 都存在。

最终报告必须列出 Core 6、Growth 3、Watch 4、Exited Watch 3、H 股 Mapping 1，以及正式持仓 9。
