import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const PORTFOLIO_QUOTES_URL =
  "https://cn-hk-quotes-proxy.zhushihao710.workers.dev/api/portfolio-quotes";

function createServer() {
  const server = new McpServer({
    name: "A股港股行情",
    version: "1.1.0",
  });

  // 保留测试工具，确认 MCP 基础链路持续正常
  server.registerTool(
    "calculate",
    {
      description: "执行基础四则运算，仅用于 MCP 连通性测试",
      inputSchema: z.object({
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      }),
    },
    async ({ operation, a, b }) => {
      let result: number;

      switch (operation) {
        case "add":
          result = a + b;
          break;
        case "subtract":
          result = a - b;
          break;
        case "multiply":
          result = a * b;
          break;
        case "divide":
          if (b === 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: Cannot divide by zero",
                },
              ],
            };
          }
          result = a / b;
          break;
      }

      return {
        content: [{ type: "text", text: String(result) }],
      };
    },
  );

  // 正式行情工具
  server.registerTool(
    "get_portfolio_quotes",
    {
      description:
        "获取当前 Core 和 Growth 投资组合的 A 股和港股结构化行情快照。返回价格、涨跌幅、成交量、成交额、日内高低点、市场状态、行情时间、来源、质量状态等。仅用于只读行情查询。",
      inputSchema: {},
    },
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(PORTFOLIO_QUOTES_URL, {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        const raw = await response.text();

        if (!response.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "UPSTREAM_HTTP_ERROR",
                    status: response.status,
                    body: raw,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        let data: unknown;

        try {
          data = JSON.parse(raw);
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "UPSTREAM_INVALID_JSON",
                    body: raw,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "UPSTREAM_FETCH_ERROR",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  return server;
}

const handler = createMcpHandler(createServer);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
