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
