# 全量标的快照 TDD 证据

## 当前契约

`portfolio_version=2026-09-01-v4` 的快照必须覆盖 23 个 `market:code` 唯一标识：8 个 Core、3 个 Growth、10 个 Watch 和 2 个 A/H Mapping。正式持仓共 11 个，映射行参与行情但不计为独立持仓。工程侧不再有 Exited Watch。

## 测试保证

| 保证 | 测试 |
|---|---|
| 23 个完整标的和派生数量正确 | `tests/portfolio-validation.test.mjs: accepts the complete v4 23-instrument snapshot and derives counts` |
| 缺少 Site 全量数组或标的会被拒绝 | `rejects a legacy or partial snapshot`、`rejects an unexpected or missing market-qualified code` |
| 所有十个 Watch、两个映射必须存在，Exited Watch 不允许进入 | `requires all Watch rows, both mappings, and no Exited Watch identity` |
| Core/Growth/Watch 与 Portfolio Status、持仓字段组合一致 | `requires all Watch rows...`、`checks derived summary totals...` |
| A/H 映射和应流股份必须按市场+完整代码区分 | `does not use pure numeric code matching...` |
| Watch 行情源失败仍保留明确错误质量 | `checks derived summary totals and allows failed Watch quote values` |

## 当前边界

- 校验模块不保存可编辑持仓配置，只固定验收 v4 的市场+完整代码集合，防止 Site 半更新或代码漂移。
- Site 的 `PORTFOLIO_UNIVERSE` 是运行时单一来源；桥接护栏和测试是防错边界，后续可改为构建时自动生成。
- Worker 发布、Site 部署和 GitHub Issue #1 的真实结果必须在每次持仓变更后重新验收。
