# 持仓行情同步规范

## 架构原则

行情服务必须查询 Site 的全量标的。主动行情数量为 10 只是当前 Core/Growth 行情池的数量，不是 Site 返回总数。

唯一真实配置源是上游 Site 的 `PORTFOLIO` 对象：

```text
PORTFOLIO { core, growth, watch }
  → STOCKS（全量）
  → /api/portfolio-quotes（全量快照）
  → MCP get_portfolio_quotes（全量快照）
  → Cloudflare Worker Cron
  → GitHub Issue #1
  → ChatGPT 监控任务按分组消费
```

MCP、GitHub 行情桥和 ChatGPT Prompt 不得维护第二份股票名单。

## 三层标的定义

### Core

当前主动行情标的：

- `300308.SZ` 中际旭创，`ACTIVE`
- `03308.HK` 中际旭创 H 股映射，`MAPPING_ONLY`，`mapping_to: 300308.SZ`
- `300502.SZ` 新易盛，`ACTIVE`
- `300394.SZ` 天孚通信，`ACTIVE`
- `688676.SH` 金盘科技，`ACTIVE`

### Growth

当前主动行情标的：

- `605376.SH` 博迁新材，`ACTIVE`
- `301183.SZ` 东田微，`ACTIVE`
- `300433.SZ` 蓝思科技，`ACTIVE`
- `688596.SH` 正帆科技，`ACTIVE`
- `588170.SH` 科创半导体材料设备 ETF，`ACTIVE`

主动行情代码顺序必须为：

```text
300308,03308,300502,300394,688676,605376,301183,300433,688596,588170
```

其中 03308 是映射观察标的，不作为独立正式持仓统计；但它属于 Core 行情返回，因此主动行情条目数仍为 10，正式 ACTIVE 持仓数为 9。

### Watch

继续保留在 Site、MCP 和 GitHub 全量快照中，但不属于主动盘中价格与资金监控。至少包括：

- `601872.SH` 招商轮船
- `09988.HK` 阿里巴巴
- `02228.HK` 晶泰控股
- `603893.SH` 瑞芯微
- `600096.SH` 云天化

开盘助手、收盘复盘、产业趋势监控、资本侧与财报公告监控中的其他观察标的也必须继续保留。退出主动持仓不能通过从 Site 删除来实现。

## Site 与接口契约

上游 `PORTFOLIO` 必须包含 `core`、`growth`、`watch`，并统一生成全量 `STOCKS`。

`/api/portfolio-quotes` 必须返回全部分组，单条结果至少明确：

- `group: Core | Growth | Watch`
- `holding_status: ACTIVE | MAPPING_ONLY | WATCH`
- `mapping_to`（仅 H 股映射使用）
- 价格、昨收、开盘、最高、最低、涨跌幅、成交量、成交额
- `market_status`、`source_status`、`quality`
- `market_data_time`、`source_update_time`、`fetch_time`、`quote_time`、`freshness_basis`、`age_seconds`

闭市快照可以是 `market_status: CLOSED`、`quality: CLOSED_SNAPSHOT`。源故障必须如实标记 `source_status: FALLBACK` 或错误状态，不得为了健康检查强行标记为 `OK`。

## 数量与校验口径

正确口径：

- `summary.total === stocks.length`，表示 Site 全量返回数
- 当前主动行情条目数为 10
- Watch 数量由实际配置决定，必须大于 0
- Watch 不得计入主动价格与资金监控数量
- `MAPPING_ONLY` 必须有 `mapping_to`，且不能被当作独立正式持仓

如果 Site 提供以下字段，消费方必须校验它们与实际分组一致：

- `summary.active_quote_total`
- `summary.active_holding_total`（如果提供）
- `summary.watch_total`
- `summary.core_total`
- `summary.growth_total`

不能再使用“`summary.total = stocks.length = 10`”作为 Site 验收标准。

## MCP 与 GitHub 行情桥

MCP `get_portfolio_quotes` 和 GitHub Issue #1 必须保存 Site 的全量快照。桥接校验必须分别确认：

- Core/Growth 主动行情条目数恰好为 10
- Watch 标的仍然存在
- 分组和 `holding_status` 正确
- 退出标的没有被错误标记为 `ACTIVE`
- `summary.total === stocks.length`
- 所有行情字段和时间字段有真实值或明确的 `null` 语义
- Watch 单个行情源失败时，保留该标的错误质量，不阻断其他主动行情

Worker 内部访问代理地址收到 HTTP 404 时，可以回退公开 Site 地址；500、超时和公开地址不可用时必须记录失败并保留上一份成功快照，等待下次重试。

## Prompt 使用规则

- 盘中价格与资金监控-Core 只消费 Core。
- 盘中价格与资金监控-Growth 只消费 Growth。
- 盘中任务不主动消费 Watch。
- 开盘助手、收盘复盘、产业趋势、资本侧与财报公告监控可以同时消费三组，但必须明确 Watch 是低优先级观察，不得报成正式持仓。

## 持仓变更规则

每次变更先记录：

```text
新增：
退出：
分组变化：
A/H 映射：
```

退出主动持仓时：

```text
Core/Growth + ACTIVE → Watch + WATCH
```

新增主动持仓时，加入 Core 或 Growth 并标记 `ACTIVE`。A/H 映射单独标记 `MAPPING_ONLY`，保留映射行情但不增加正式持仓数。

## 最终一致性验收

### 主动行情一致性

```text
Active Core/Growth
  ↕
主动行情子集（10 条）
  ↕
Core/Growth 盘中 Prompt
```

### 全量覆盖一致性

```text
Site 全量标的
  ↕
MCP 全量标的
  ↕
GitHub Issue #1 全量快照
```

### 观察覆盖一致性

```text
Watch 标的
  ↕
开盘助手 / 收盘复盘 / 产业趋势 / 资本公告监控
```

验收时必须分别列出主动代码和 Watch 代码，不能只报告一个总数。
