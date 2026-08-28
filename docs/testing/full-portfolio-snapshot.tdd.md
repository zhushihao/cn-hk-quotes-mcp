# 全量标的快照 TDD 证据

## 来源与用户旅程

本轮用户旅程直接来自架构修正要求：

- 作为行情桥接维护者，我希望 Site 返回 Core、Growth、Watch 的全量快照，以便退出主动持仓的标的仍能被观察。
- 作为盘中监控消费者，我希望能从快照中单独计算主动行情数量，以便 Watch 不会混入价格与资金监控。
- 作为桥接维护者，我希望 Watch 单个行情源失败仍保留错误状态，以便不阻断其他主动行情。

## RED / GREEN 记录

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED | `node --experimental-strip-types --test tests/portfolio-validation.test.mjs` | 失败：`src/portfolio-validation.ts` 尚不存在，暴露了全量校验实现缺口 |
| GREEN | `npm test` | 10 个测试通过 |
| 类型与静态检查 | `npm run type-check`、`./node_modules/.bin/oxlint src tests` | 通过 |
| 覆盖率 | `npm run test:coverage` | 行覆盖率 92.24%，分支覆盖率 82.93% |

## 测试保证

| # | 保证 | 测试 |
|---|---|---|
| 1 | 全量快照可以同时包含 10 个主动行情条目和 Watch 条目，并分别计算 Core/Growth/Watch 数量 | `tests/portfolio-validation.test.mjs: accepts a full snapshot` |
| 2 | 只有主动行情的旧快照会被拒绝 | `tests/portfolio-validation.test.mjs: rejects a legacy active-only snapshot` |
| 3 | 主动行情数量不是 10 时会被拒绝 | `tests/portfolio-validation.test.mjs: rejects snapshots whose active quote count is not ten` |
| 4 | 数量为 10 但主动代码被替换时会被拒绝 | `tests/portfolio-validation.test.mjs: rejects a ten-record active set when one code is substituted` |
| 5 | 五个基线 Watch 代码必须继续存在 | `tests/portfolio-validation.test.mjs: requires every baseline Watch code to remain present` |
| 6 | Core/Growth/Watch 与持仓状态组合必须一致 | `tests/portfolio-validation.test.mjs: rejects inconsistent group and holding status combinations` |
| 7 | `MAPPING_ONLY` 必须有映射目标 | `tests/portfolio-validation.test.mjs: requires an H-share mapping target` |
| 8 | `summary.total` 必须等于返回数组长度 | `tests/portfolio-validation.test.mjs: rejects summary totals` |
| 9 | Site 提供的派生汇总字段必须与实际分组一致 | `tests/portfolio-validation.test.mjs: checks optional derived summary fields` |
| 10 | Watch 行情源失败可以保留空行情和明确错误质量，不阻断整批校验 | `tests/portfolio-validation.test.mjs: keeps a Watch source failure` |

## 当前边界

- 校验模块不保存完整持仓配置，但会固定验收当前约定的 10 个主动代码和 5 个基线 Watch 代码，防止“数量正确、代码错误”的漂移。
- Site 已部署 `PORTFOLIO { core, growth, watch }`，生产 `/api/portfolio-quotes` 已返回 15 条：Core 5、Growth 5、Watch 5。
- Cloudflare Worker 发布和 GitHub Issue #1 全量快照仍需在 Site 更新后重新验收。
