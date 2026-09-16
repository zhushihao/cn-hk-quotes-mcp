# RIWS Cloud C0 基线与渐进架构规格

日期：2026-09-12（Asia/Shanghai）

历史设计起点：`cce723b7f7663de888a48e3468bbbc595e999f95`

发布与差异验证基线：`f990f9a1f0f1c7a457e2e42797c648c4c3055033`

## 1. 结论

当前工作的正确边界是新增一条独立的公开行情投影，同时把现有动态组合输出明确标为私有持仓投影。首批代码只建立这两个边界，不改旧路由、旧 schema、Issue #1、GitHub Actions、Cron、MCP 旧工具或任何线上消费者，也不部署。

Issue #1 当前包含旧的持仓身份与数量字段，但线上任务仍依赖它。旧内容现在保留，不算首批代码的阻塞项。只有新公开通道完成影子验证、消费者逐项切换并取得单独授权后，才讨论 Issue #1 清理和旧链退役。整个迁移必须零中断。

公开新通道只显示行情，不显示最新持仓身份；私有通道继续受鉴权并只服务获准的持仓上下文。C1 Validator、#2/#3 单 writer 和状态恢复保留为后续里程碑，先用真实并发、重复写入或恢复问题证明复杂基础设施的必要性，不预先指定 Durable Object、通用事件平台、Reducer、Checkpoint 或 outbox。

## 2. 当前事实

- 集成基线已包含 `portfolio-status/1`、`LIVE_COMPLETE / LKG_VALID / PORTFOLIO_UNKNOWN` 三态、LRCCA 双轨 freshness anchor、status/universe 交叉检查、`/api/github-auth/portfolio-status`，并新增 `src/live-overlay.ts` 的 request-scoped bearer gate、`live_overlay_status` 和调用方错误证券代码脱敏。这些均是上游 `f990f9a` 的能力，不是本次公开投影 PR 新增的能力。
- 当前集成结果的聚焦测试为 10/10 通过，全套为 51/51 通过，`npm run type-check` 通过。
- `oxlint src tests` 的既有失败位于 `tests/live-universe.test.mjs:36`，共 22 个上游未使用参数诊断；公开投影改动没有新增诊断。
- `src/index.ts` 中 `/api/portfolio-quotes` 通过 request-scoped bearer gate 要求 `PORTFOLIO_UNIVERSE_TOKEN`，并按上游 `portfolio-status/1` 三态、LRCCA、新鲜度和 coverage 规则决定是否应用 `applyLiveUniverse()`。
- MCP `get_portfolio_quotes` 也使用同一 request-scoped bearer gate：有效 bearer 才能应用 LIVE overlay；未授权调用返回 legacy catalog，并通过 `control_plane_status.live_overlay_status` 标明跳过原因。它属于旧消费者面，本轮不原地改语义；新公开 MCP 能力使用不同工具名。
- Worker Cron 和 `.github/workflows/update-quote-bridge.yml` 都能更新 Issue #1；二者现有行为本轮不变。
- 公开 Issue #1 当前正文含 `active_holding_total`、`position_qty` 和 `is_position`。用户确认在新链可用前保留现状。
- 当前账户可见 9 个活动 Scheduled Tasks；任务级 MCP、Plugin、Connector 和通知权限仍为 `AGENT_CONSUMPTION_UNVERIFIED`。
- #2/#3 分别承担市场与研究状态账本职责；GitHub comments 是 append-only 记录，不提供数据库式 CAS。

事实来源为总计划 [Issue #4](https://github.com/zhushihao/quantpro-collector/issues/4)、本机计划 [Issue #5](https://github.com/zhushihao/quantpro-collector/issues/5)、[Issue #1](https://github.com/zhushihao/quantpro-collector/issues/1)、[Issue #2](https://github.com/zhushihao/quantpro-collector/issues/2)、[Issue #3](https://github.com/zhushihao/quantpro-collector/issues/3) 和上述固定 SHA 源码。源码存在某条路径不等于它已经部署。

## 3. 目标与非目标

### 3.1 目标

1. 新增不读取 LIVE universe 的公开行情投影，任何 LIVE 集合变化都不改变它的行集合。
2. 明确现有 LIVE overlay 是 request-scoped 私有能力，并原样保留上游 bearer gate、`live_overlay_status`、三态 LIVE/LRCCA、错误脱敏与失败关闭行为。
3. 复用 `validateSnapshot()`、`applyLiveUniverse()`、`getLiveUniverseCoverage()` 与现有测试 fixture，不建立新平台。
4. 为以后影子验证、消费者切换和旧链退役提供可观察的验收门。
5. 保留 #2/#3 现有逻辑职责，同时明确后续写入不能把 comments 当成 CAS。

### 3.2 非目标

- 不修改或清理 Issue #1，不改 Actions 权限或逻辑，不停用任何 writer。
- 不改变 `/api/portfolio-quotes`、`/api/quote-universe`、现有 MCP 工具或旧 JSON schema。
- 不部署、不切换 Cron、不修改 Scheduled Tasks、不触发 workflow。
- 不实现 Validator、通用 event envelope、Reducer、Checkpoint、outbox 或新的状态数据库。
- 不接触 QQ/QMT，不创建交易能力，不把 GitHub 身份认证当作 LIVE 完整性证明。

## 4. 方案比较

### 4.1 方案 A：直接修改旧链为公开脱敏输出

可以快速消除新输出中的持仓身份，但会立刻改变 Issue #1、旧 MCP、Actions 和 Scheduled Tasks 的输入，存在中断风险。当前没有完整消费者清单和任务权限实测，因此拒绝。

### 4.2 方案 B：先建设完整事件和强一致状态平台

能一次解决未来 Validator、幂等、并发和恢复问题，但目前没有足够证据证明这些问题需要独立基础设施；它扩大首批改动和故障面，也不能直接解决零中断迁移。当前拒绝。

### 4.3 方案 C：新增旁路公开投影，保留旧链（推荐）

新增 `public_quote_snapshot/1` 和独立 route/tool，不碰旧接口；同时把现有动态路径明确测试为私有。新链先在本地和 preview 使用合成数据验证，再经单独授权影子运行。消费者切换完成前 Issue #1 和旧链照常运行。

**决定 —** 采用方案 C。

**技术原因 —** 它复用现有代码和测试缝，以最少文件建立真正的隐私边界，并允许逐消费者切换。

**判断错误的产品代价 —** 如果新公开投影仍依赖 LIVE 集合，会在不含数量的情况下泄漏持仓身份；如果提前停旧链，会让当前自动任务失去输入。

## 5. 首批接口与字段契约

### 5.1 新公开行情投影

新增接口建议为：

- `GET /api/public/quotes`：匿名，只返回 `public_quote_snapshot/1`；
- MCP `get_public_quotes`：空输入，返回同一 `public_quote_snapshot/1`。

这两个名称与旧接口并存，不能把旧 `/api/portfolio-quotes` 重定向到新接口，也不能原地更改 `get_portfolio_quotes`。

`public_quote_snapshot/1` 顶层允许 `schema_version`、`snapshot_time`、`market_status`、`source_mode`、`system_quality`、`summary.total`、`summary.usable` 和 `stocks`。

每个公开 `stocks` 行只允许：

- 身份：`market`、`exchange`、`code`、`name`；
- 行情：`price`、`change`、`change_pct`、`pre_close`、`prev_close`、`open`、`high`、`low`、`pct_change`、`volume`、`amount`；
- 质量与时间：`market_status`、`market_data_time`、`source_update_time`、`freshness_basis`、`quote_time`、`fetch_time`、`age_seconds`、`primary_source`、`secondary_source`、`source_status`、`quality`。

公开投影禁止：`portfolio_universe`、`portfolio_version`、`group`、`portfolio_group`、`portfolio_status`、`holding_status`、`mapping_only`、`mapped_to`、`mapping_to`、`position_qty`、`is_position`、active/holding 计数、LIVE code/hash/count/status、账号、成本、订单和凭据。

公开行集合必须来自未经 `applyLiveUniverse()` 处理的稳定 quote catalog。测试要证明 LIVE 集合 A、B 变化时公开结果的 `market:code` 集合不变。公开上游不能指回新 route 自身形成递归。

### 5.2 私有持仓投影

现有 `GET /api/portfolio-quotes` 暂时保留原路径、schema、request-scoped bearer gate 和错误行为：

- 无 token 或错误 token：`401 UNAUTHORIZED`；
- KV 未配置：`503 PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED`；
- LIVE 缺失、过期或 coverage 不完整：失败关闭，不返回部分组合；
- 正常：返回当前动态组合行情。

首批代码保持私有 route 实现不变。`position_qty` 当前在 `applyLiveUniverse()` 后为 `null`；私有输出仍不得新增成本、账号、订单或凭据。

上游私有语义还包括：缺少或无效 `portfolio-status/1` 时保守进入 `PORTFOLIO_UNKNOWN`；三态与 universe 不一致时失败关闭；LIVE 不可用时按照 LRCCA 双轨 freshness anchor 判断 LKG，而不是用下游读取时间刷新。私有 `/api/portfolio-quotes` 会按具体失败返回 `LIVE_UNIVERSE_STALE` 或 `PORTFOLIO_UNKNOWN`；调用方错误文本通过 `clientFacingErrorMessage()` 去除证券代码。新公开 route/tool 不读取、改写或推断这些状态，也不参与 `src/live-overlay.ts` 的授权判断。

### 5.3 Issue #1、Actions 与旧 MCP

- Issue #1 正文和 schema 不变。
- Worker scheduled writer 不变。
- Actions 的 `issues: write`、固定契约和手工补跑能力不变。
- MCP `get_portfolio_quotes` 不变。
- 新 route/tool 的加入不能改变上述路径的返回、更新频率、fallback 或错误语义。

这是兼容约束，不代表旧内容已经满足最终隐私目标。旧链退役只在新链影子验证和消费者切换后处理。

## 6. 状态、时序和错误

新公开请求只有 `SUCCESS` 或 `UPSTREAM_UNAVAILABLE`：上游 JSON 先经现有 `validateSnapshot()`，再显式拣选公开字段；解析、校验或投影失败返回 `502`，不得回退到私有 LIVE 输出。响应使用 `Cache-Control: no-store`，错误只含闭集 error code 和脱敏 message。

私有 REST 请求继续执行上游 `f990f9a` 已有流程：计算本请求的 LIVE overlay bearer gate → 未授权返回 401 → 读取 `portfolio-status/1` 与 LIVE universe → 三态/LRCCA/新鲜度和一致性检查 → 获取 catalog → coverage 检查 → 在允许状态下应用 `applyLiveUniverse()` → 响应；调用方错误文本去除证券代码。旧 MCP 请求也先计算同一 gate，未授权时跳过 overlay 并携带 `live_overlay_status`。新公开请求只执行：获取稳定 catalog → `validateSnapshot()` → public projection → privacy assertion → 响应。公开流程不进入 overlay gate，两个流程不得互相 fallback。

## 7. #2/#3 与后续里程碑

#2 继续记录市场观察和市场状态，#3 继续记录产业、公司和研究状态。本轮不改变 producer、comment schema 或消费者。后续 Validator 应先通过实际历史错误和新写入需求确定最小规则；后续单 writer 应先证明存在并发 writer 或重复写入风险；后续恢复能力应先给出允许的恢复时间和数据丢失目标。

无论以后选用哪种存储，GitHub comments 都只能作为 append-only 发布/审计记录，不能作为原子 CAS。基础设施选择必须在这些真实需求明确后另写规格，不在本轮锁定 Durable Object 或数据库。

## 8. 零中断迁移门

迁移顺序固定为：

1. 合并最小代码，但不部署；
2. 经单独授权部署新 route/tool，旧链保持不变；
3. 使用合成数据和非敏感 catalog 影子验证新公开输出；
4. 逐个实测消费者能读取新通道，记录旧/新结果差异；
5. 经单独授权修改一个消费者，并保留可立即回到旧链的配置；
6. 所有消费者稳定后，再决定 Issue #1 清理、Actions/Worker writer 收口和旧接口退役。

任一步失败都停止后续切换，旧链继续服务。不得为了验证新链暂停、重写或清空 Issue #1。

## 9. 测试矩阵与验收

| 范围 | 必测行为 | 通过标准 |
|---|---|---|
| Public fields | 含全部旧身份字段的 snapshot 投影 | 输出仅含白名单，禁止键递归扫描为零 |
| Public set independence | LIVE 集合 A/B | 新公开 `market:code` 集合完全相同 |
| Public errors | 上游 404/500、非法 JSON、非法 snapshot | 502，且不返回私有 fallback |
| Private auth | 无 token、错 token、合法 token | 401、401、原有成功 schema |
| Private fail closed | KV 缺失、LIVE 过期、coverage 缺口 | 保持原有错误，不返回部分集合 |
| Compatibility | 旧 REST、旧 MCP、Issue body、scheduled、Actions | 与固定基线行为/文本快照无差异 |
| Agent consumption | 隔离任务实际读取与通知 | 未取得真实日志前保持 `AGENT_CONSUMPTION_UNVERIFIED` |

首批代码验收实际结果：聚焦公开投影/route 测试 10/10 通过，全套 51/51 通过，type-check 通过；lint 只保留 `tests/live-universe.test.mjs:36` 的 22 个上游既有诊断且无新增失败；相对发布基线 `f990f9a1f0f1c7a457e2e42797c648c4c3055033` 的差异不包含 workflow、wrangler、Issue、自动任务配置或上游 LIVE/overlay 文件；没有网络部署或生产写入。

## 10. 回滚与待批准事项

首批代码只新增旁路能力，回滚为 revert 该 PR；旧链无需数据恢复。未来部署新 route/tool 后如探针失败，只撤回新部署或停止新消费者切换，旧链继续运行。

以下操作都需要再次批准：部署、影子线上探针、Scheduled Task 或其他消费者切换、Issue #1 清理、Actions/Worker writer 收口、旧 route/tool 退役、#2/#3 Validator 或状态恢复实现。`AGENT_CONSUMPTION_UNVERIFIED` 在真实隔离验收前不得解除。
