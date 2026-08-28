# 持仓行情同步规范

本仓库的行情标的只允许从上游 `PORTFOLIO` 配置产生。MCP、GitHub 行情桥和 ChatGPT 监控任务都属于下游消费者，不得各自维护第二份行情股票名单。

## 变更前记录

任何新增持仓、清仓、Core/Growth 调整或 A/H 映射变化，先在变更说明中写清楚以下四项：

```text
新增：
退出：
分组变化：
A/H 映射：
```

其中，A/H 映射必须说明映射方向；仅用于观察的映射标的要保留 `holding_status: "MAPPING_ONLY"` 和 `mapping_to`，不能被当成独立持仓。

## 统一修改顺序

1. 只修改上游站点仓库的 `lib/stocks.ts` 中 `PORTFOLIO` 配置，并由它生成 `STOCKS`。
2. 部署上游站点后，验证 `/api/portfolio-quotes` 的代码顺序、总数、分组和行情字段。
3. 验证 MCP `get_portfolio_quotes` 与上游返回同一批标的；MCP 不得复制股票列表。
4. 让 Cloudflare Worker Cron 通过 MCP 上游刷新 GitHub Issue #1；GitHub Actions 只保留手工 `workflow_dispatch` 补跑。
5. 只有上游、MCP、Issue 桥和 Cron 日志全部通过后，才同步 ChatGPT 监控任务的消费分组。

## 退出标的规则

清仓标的必须从主动盘中行情池和对应的 Core/Growth 消费分组中移除。产业趋势或公告任务可以保留为低优先级观察，但这类观察不能反向进入行情池。

## 变更验收清单

- [ ] 上游 `PORTFOLIO` 是唯一真实配置源。
- [ ] 上游和 MCP 的代码集合、顺序、分组完全一致。
- [ ] 新增标的的价格、昨收、开高低、涨跌幅、成交量、成交额、市场状态、源时间和质量字段都有效。
- [ ] Issue #1 的 `snapshot.snapshot_time` 来自上游，不使用 Issue `updated_at` 冒充。
- [ ] Issue #1 的 `bridge.last_attempt_status`、`last_success_at`、`workflow_run_id` 与真实 Worker 执行一致。
- [ ] Cron 仍由 Cloudflare 调度，没有新增长期 GitHub Actions 定时器。
- [ ] ChatGPT 监控任务只消费已验收的 Core/Growth 分组。
