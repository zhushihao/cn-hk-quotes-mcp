# QuantPro Collector

> QuantPro 的统一远程 MCP Collector / Gateway。

`QuantPro Collector` 是现有 `cn-hk-quotes-mcp` 服务的产品名称。仓库名、Cloudflare Worker URL、鉴权 token 环境变量和既有工具名保持兼容；命名调整不应破坏现有 LIVE overlay、行情查询和 Codex/ChatGPT 客户端配置。

当前已承载的只读能力包括：

- `get_portfolio_quotes`：受鉴权的 LIVE 持仓行情视图；
- `get_public_quotes`：不含真实持仓身份的公开行情视图；
- `get_control_plane_status`：LIVE 控制面健康与 freshness 状态。

后续 RIWS 研究基础设施能力继续通过同一个 **QuantPro Collector** 暴露给 ChatGPT，不另建第二个公网 Research MCP。RESEARCH 机器负责采集、Evidence、Accumulator 与 Work Queue；ChatGPT 是唯一投资研究 Agent。

## Compatibility

为避免对已上线链路造成破坏，以下标识暂不因产品改名而变化：

- GitHub repository: `zhushihao/cn-hk-quotes-mcp`
- 已部署 Worker / MCP endpoint URL
- `PORTFOLIO_UNIVERSE_TOKEN` 等现有运行时配置名
- 已发布 MCP tool 名称

这些属于接口兼容标识，不代表产品仍名为 `A/H股行情` 或 `cn-hk-quotes`。

## MCP Server

该仓库基于 Cloudflare Workers 提供远程 MCP 服务。生产私域能力必须经过鉴权；匿名/未授权请求不得获得 LIVE overlay 或私域研究数据。

### 生产 `market:read` 鉴权

ChatGPT 与 ChatGPT Automation 共用一个批准的 QuantPro Collector 生产 client identity：`chatgpt-production`。当前认证模式为 Remote MCP 请求级 Bearer client credential，最小授权 scope 为 `market:read`。

- 外部 client secret：Cloudflare secret `COLLECTOR_MCP_CLIENT_TOKEN`。它只用于 MCP client 身份认证，不写入 Git、Prompt、tool schema、日志或响应。
- 非敏感身份/权限映射：`COLLECTOR_MCP_CLIENT_ID=chatgpt-production`、`COLLECTOR_MCP_CLIENT_SCOPES=market:read`。
- `COLLECTOR_MCP_CLIENT_ID` 是正式 principal 的必需配置；credential 即使正确，缺 identity 也会 fail-closed，不允许出现“有 token、无主体”的 LIVE 读取。
- 成功鉴权只向控制面/结构化日志写脱敏审计字段（认证模式、`client_id`、scope）；未授权时 identity/scope 不外露，任何 bearer/secret 均不记录。
- 内部 `PORTFOLIO_UNIVERSE_TOKEN` 继续只保护 universe API / writer 与内部动态行情端点；它**不是** ChatGPT credential，MCP 请求携带该内部 token 也不会因此获得 LIVE overlay。
- credential 正确但缺少 `market:read` 时返回 `SKIPPED_INSUFFICIENT_SCOPE`；credential 缺失/错误继续 fail-closed 为 `SKIPPED_*`，并走 quote-only 投影。
- credential 轮换只需更新 Cloudflare secret 与 ChatGPT 连接侧保存的 credential，不需要把 secret 写进 Prompt、tool 参数或源码。

Research read 权限面保持独立：本变更不把 `market:read` 提升为 `research:read` / claim / submit，也不改变现有 PUBLIC Research replica 的可见性规则。
