# QuantPro Collector

> QuantPro 的统一远程 MCP Collector / Gateway。

`QuantPro Collector` 是现有 `cn-hk-quotes-mcp` 服务的产品名称。仓库名、Cloudflare Worker URL 和既有工具名保持兼容；命名调整不应破坏现有 LIVE overlay、行情查询和 Codex/ChatGPT 客户端配置。

当前已承载的只读能力包括：

- `get_portfolio_quotes`：受鉴权的 LIVE 持仓行情视图；
- `get_public_quotes`：不含真实持仓身份的公开行情视图；
- `get_control_plane_status`：LIVE 控制面健康与 freshness 状态。

后续 RIWS 研究基础设施能力继续通过同一个 **QuantPro Collector** 暴露给 ChatGPT，不另建第二个公网 Research MCP。RESEARCH 机器负责采集、Evidence、Accumulator 与 Work Queue；ChatGPT 是唯一投资研究 Agent。

## Compatibility

为避免对已上线链路造成破坏，以下标识暂不因产品改名而变化：

- GitHub repository: `zhushihao/quantpro-collector`
- 生产 MCP endpoint: `https://cn-hk-quotes-mcp.zhushihao710.workers.dev/mcp`
- 内部 `PORTFOLIO_UNIVERSE_TOKEN` 配置名
- 已发布 MCP tool 名称

这些属于接口兼容标识，不代表产品仍名为 `A/H股行情` 或 `cn-hk-quotes`。

## MCP Server

该仓库基于 Cloudflare Workers 提供远程 MCP 服务。公开能力可匿名读取；生产私域能力必须经过鉴权，匿名/未授权请求不得获得 LIVE overlay 或私域研究数据。

### 生产 `market:read` OAuth

ChatGPT 与 ChatGPT Automation 使用标准 Remote MCP OAuth 2.1 授权码流程（PKCE S256），最小授权 scope 为 `market:read`。OAuth discovery、动态客户端注册、access token、refresh token 和 token audience 均由 `@cloudflare/workers-oauth-provider` + 独立 `OAUTH_KV` 管理。

生产链：

```text
ChatGPT / Automation
  -> OAuth discovery + PKCE authorization code
  -> access token (audience = QuantPro Collector /mcp)
  -> scope = market:read
  -> OAuth gateway
  -> LIVE overlay read permission
  -> Worker 内部读取 PORTFOLIO_UNIVERSE KV
```

安全边界：

- `PORTFOLIO_UNIVERSE_TOKEN` 继续只保护 universe API / writer 与内部动态行情端点；它**不是** ChatGPT OAuth credential。
- `COLLECTOR_MCP_CLIENT_TOKEN` 不再交给 ChatGPT。它只保留在 Cloudflare secret 中，用于 QuantPro owner 在 `/authorize` 页面完成一次人工授权，并作为 OAuth gateway 到既有 core market-read gate 的 server-only bridge；外部请求携带它不能绕过 OAuth。
- 非敏感生产 principal 仍为 `COLLECTOR_MCP_CLIENT_ID=chatgpt-production`，最小 scope 为 `market:read`。
- authorization server metadata 同时声明 `offline_access`，并签发 refresh token；ChatGPT 无需把 secret 写入 Prompt、tool 参数或应用配置。
- access token 必须同时满足：有效、未过期、audience 精确匹配生产 `/mcp`、`market:read` scope 存在、owner principal 匹配；任一失败均 fail-closed。
- 静态旧 Bearer 不再是公网 MCP 客户端认证方式：OAuth adapter 会先验证 OAuth access token，绝不把外部 `Authorization` 原样传给 core。
- 匿名 MCP 仍保留用于公开/quote-only 能力；`get_portfolio_quotes` 匿名调用继续由 core 投影为 quote-only，不读取或暴露 LIVE active set、数量、hash 或 coverage 代码。
- `get_public_quotes` 与 PUBLIC Research replica 保持原有匿名只读边界；本 OAuth 不授予交易、账户、成本、订单、撤单，也不把 `market:read` 升格为 PRIVATE Research 权限。

### OAuth endpoints

- authorization server metadata: `/.well-known/oauth-authorization-server`
- protected-resource metadata: `/.well-known/oauth-protected-resource/mcp`
- authorization: `/authorize`
- token / revocation: `/oauth/token`
- dynamic client registration: `/oauth/register`
- MCP resource: `/mcp`

只有 `market:read` 和用于续期的 `offline_access` 会被 owner 授权页接受；其他 scope 请求拒绝。
