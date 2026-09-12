# RIWS Cloud 最小公开/私有投影实施计划

Spec: `docs/superpowers/specs/2026-09-12-riws-cloud-c0-design.md`

历史设计起点是 `cce723b7f7663de888a48e3468bbbc595e999f95`；发布与差异验证基线是 `f990f9a1f0f1c7a457e2e42797c648c4c3055033`。本计划只定义一个最小代码 PR 的范围，不授权部署、Issue 改写、workflow 触发、消费者切换、Scheduled Task 变更或 QQ/QMT 访问。

## 1. 待审阅的最小代码工作

### 1.1 文件与职责

| 路径 | 动作 | 生产者 | 消费者 |
|---|---|---|---|
| `src/quote-projections.ts` | 新增 `toPublicQuoteSnapshot()` 和公开 privacy assertion | 已验证 quote catalog | 新公开 route/tool |
| `src/index.ts` | 注册新 `/api/public/quotes` 和 `get_public_quotes` | Worker | 新消费者；旧消费者保持原样 |
| `tests/quote-projections.test.mjs` | 新增公开字段和 LIVE metadata 独立测试 | 合成 snapshot fixture | Node test runner |
| `tests/public-quotes-route.test.mjs` | 新增新 route/tool 与错误隔离测试 | mock fetch/env | Node test runner |

只新增一个产品模块。上游 `f990f9a` 已提供 `portfolio-status/1`、三态 LIVE、LRCCA、request-scoped LIVE overlay bearer gate、`live_overlay_status` 与证券代码脱敏的调用方错误语义；`src/live-overlay.ts` 及这些上游模块和测试保持原样，本 PR 不增加通用路由框架。

明确禁止修改：`.github/workflows/update-quote-bridge.yml`、`wrangler.jsonc`、`worker-configuration.d.ts`、`PORTFOLIO_SYNC.md`、Issue #1、现有自动任务，以及任何旧 route/tool 的名称、schema、fallback、错误或 writer 行为。

### 1.2 稳定接口

- `toPublicQuoteSnapshot(catalog)`：输入先通过现有 `validateSnapshot()`；输出严格为 `public_quote_snapshot/1`，显式逐字段拣选。
- `GET /api/public/quotes`：匿名，返回 `public_quote_snapshot/1`；失败为 `502 UPSTREAM_UNAVAILABLE`。
- `get_public_quotes`：空输入，返回与 public route 相同的 JSON。
- 旧 `GET /api/portfolio-quotes` 和 `get_portfolio_quotes`：行为保持固定基线，不重定向、不改 schema。

### 1.3 实施步骤

1. 在 `tests/quote-projections.test.mjs` 复用现有 snapshot 构造方式，建立含 `portfolio_universe`、分组、`position_qty`、`is_position` 和 active 计数的合成 catalog。先写断言：公开输出只含规格白名单；递归禁止键扫描为零。
2. 用带不同 LIVE metadata 的合成情形证明 `toPublicQuoteSnapshot()` 不保留或推断 LIVE 内容；私有投影继续由上游旧链及其现有测试负责。
3. 实现 `src/quote-projections.ts`。公开投影使用显式构造，不使用对象 spread 后删字段；privacy assertion 遇未知顶层/行字段或禁止键直接失败。
4. 在 `src/index.ts` 新增只使用 public Site 的 catalog loader。新公开 route/tool 只走 catalog → validate → public projection；不得传入 env，也不得读取 `PORTFOLIO_UNIVERSE` 或 `portfolio-status/1`。
5. 保持现有私有 route 实现不变，通过固定基线差异检查证明其路径、响应和错误语义没有改变。
6. 在 `tests/public-quotes-route.test.mjs` 覆盖 route/tool 同形状、上游 404/500、非法 JSON、非法 snapshot；所有失败都不得调用 LIVE 或返回旧私有结果。
7. 对现有 route、MCP 注册名、Issue body、scheduled handler 和 workflow 做静态差异检查，确认零中断约束。

### 1.4 测试命令与预期结果

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-strip-types --test tests/quote-projections.test.mjs tests/public-quotes-route.test.mjs
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run type-check
PATH=/opt/homebrew/opt/node@22/bin:$PATH ./node_modules/.bin/oxlint src tests
git diff --check
git diff --exit-code f990f9a1f0f1c7a457e2e42797c648c4c3055033..HEAD -- .github/workflows/update-quote-bridge.yml wrangler.jsonc worker-configuration.d.ts PORTFOLIO_SYNC.md src/live-universe.ts src/portfolio-status.ts src/live-overlay.ts tests/live-universe.test.mjs tests/portfolio-status.test.mjs tests/live-overlay.test.mjs
```

实际结果：聚焦测试 10/10 通过；全套 51/51 通过；type-check 通过；lint 仅有 `tests/live-universe.test.mjs:36` 的 22 个上游既有 unused-parameter 诊断，没有本 PR 新增诊断；`git diff --check` 通过；最后一条命令退出 0，证明上游 LIVE/status/overlay 与明确禁止的文件没有变化。

差异核对以 `git diff f990f9a1f0f1c7a457e2e42797c648c4c3055033..HEAD -- src/index.ts` 为准：只有公开 import、public loader、新 MCP tool、新 REST handler 和 route registration；上游 request-scoped overlay gate、`live_overlay_status`、错误证券代码脱敏，以及旧 `/api/portfolio-quotes`、`/api/quote-universe`、`/api/github-auth/portfolio-status`、`get_portfolio_quotes`、`updateQuoteBridge()`、`createIssueBody()` 和 `scheduled()` 的可观察契约没有变化。

### 1.5 回滚与验收

该 PR 只增加旁路能力，回滚为 revert PR；不需要修改或恢复 Issue #1。验收结论只能是“新通道代码可供后续部署验证”，不能宣称线上隐私迁移完成。

## 2. 后续需要再次批准的线上切换

这些步骤不属于最小代码 PR：

1. 部署含新 route/tool 的 Worker，同时保持旧 route、MCP、Issue #1、Cron 和 Actions 不变。
2. 对新公开 route/tool 做匿名影子探针，确认字段白名单、LIVE 集合独立、延迟和错误率。
3. 用专门隔离任务实测 Scheduled Task 是否能读取新工具、读取 receipt 和投递隔离通知；逐项记录能力，未测项保留 `AGENT_CONSUMPTION_UNVERIFIED`。
4. 每次只切换一个消费者，保留可立即恢复旧配置的回滚点，并观察至少一个完整业务周期。
5. 所有消费者稳定后，另行决定 Issue #1 内容清理、Worker/Actions writer 收口和旧接口退役。清理前不得停止旧链。

每一步都需要独立的当前状态证据；代码合并、端口响应或一次任务成功不能替代完整迁移验收。

## 3. 暂缓的 C1/C2 能力

### 3.1 Validator 与写入收口

只有出现以下证据之一才启动新规格：多个 producer 需要写 #2/#3、历史非法 schema 仍持续产生、重复写造成业务状态错误、或权限不能靠现有入口闭集约束。届时先定义最小 schema adapter、producer 权限、幂等键和 quarantine；是否需要独立 gateway 由请求量和部署边界决定。

### 3.2 单 writer 与并发控制

GitHub comments 不能作为 CAS。若实测存在并发写、乱序覆盖或跨 #2/#3 原子要求，再比较串行队列、现有 Worker 内简单锁/版本检查、Durable Object 或其他存储。没有并发量、冲突频率和一致性目标前不选基础设施。

### 3.3 状态恢复

只有正式状态已经超出 GitHub append-only 重放能力，或明确恢复时间/数据丢失目标后，才设计 reducer、checkpoint 和 outbox。设计必须先证明普通顺序重放不足，再决定快照频率、hash、watermark 和恢复存储。

### 3.4 #2/#3 职责

#2 继续是市场状态逻辑账本，#3 继续是研究状态逻辑账本。暂缓能力不得建立第二份正式投资判断，也不得修改历史 comments。未来任何 publisher 都必须把 comments 视为发布/审计记录，而不是 CAS 数据库。

## 4. 可并行边界

首批 PR 很小，优先顺序实现以减少契约分裂。投影单元测试与 route 错误测试可以独立编写；`src/quote-projections.ts` 稳定后再改 `src/index.ts`。`src/index.ts` 只有一个修改负责人；新 route/tool 集成后统一运行全套测试和静态兼容检查。

后续线上切换必须串行：部署新通道、影子验证、隔离任务验收、单消费者切换、观察、下一消费者。Issue #1 清理和 writer 收口只能排在所有消费者切换之后。

## 5. 完成交付判据

首批 PR 完成只代表：新增公开行情投影通过 10 项聚焦测试，上游 request-scoped 私有 overlay、`live_overlay_status`、错误脱敏和三态/LRCCA 语义由集成基线现有测试保持，旧链代码未改变，全套 51 项通过。它不代表部署成功、Issue #1 已脱敏、自动任务已经能消费新工具或 #2/#3 状态平台已经完成。
