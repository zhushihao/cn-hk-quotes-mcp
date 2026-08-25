import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const PORTFOLIO_QUOTES_URL =
  "https://cn-hk-quotes-proxy.zhushihao710.workers.dev/api/portfolio-quotes";
const GITHUB_REPOSITORY = "zhushihao/cn-hk-quotes-mcp";
const GITHUB_ISSUE_NUMBER = 1;
const GITHUB_API_VERSION = "2022-11-28";

interface Env {
  GITHUB_TOKEN: string;
}

type QuoteSnapshot = {
  snapshot_time: string;
  system_quality: string;
  summary: {
    total: number;
    [key: string]: unknown;
  };
  stocks: unknown[];
  [key: string]: unknown;
};

type BridgePayload = {
  schema_version: "1.0";
  bridge: {
    last_attempt_at: string;
    last_attempt_status: "SUCCESS" | "FAIL";
    last_success_at: string | null;
    workflow_run_id: string;
    workflow_run_attempt: string;
    source: string;
    error: string | null;
  };
  snapshot: QuoteSnapshot | null;
};

type GitHubIssue = {
  body?: string | null;
};

const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)\s*```/i;

function parsePreviousBridge(body: string | null | undefined): {
  snapshot: QuoteSnapshot | null;
  lastSuccessAt: string | null;
} {
  if (!body) {
    return { snapshot: null, lastSuccessAt: null };
  }

  const match = body.match(JSON_BLOCK_PATTERN);
  if (!match) {
    return { snapshot: null, lastSuccessAt: null };
  }

  try {
    const payload = JSON.parse(match[1]) as Partial<BridgePayload>;
    return {
      snapshot: payload.snapshot ?? null,
      lastSuccessAt: payload.bridge?.last_success_at ?? null,
    };
  } catch {
    return { snapshot: null, lastSuccessAt: null };
  }
}

function validateSnapshot(value: unknown): asserts value is QuoteSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("upstream returned non-object JSON");
  }

  const snapshot = value as Partial<QuoteSnapshot>;
  if (
    typeof snapshot.snapshot_time !== "string" ||
    typeof snapshot.system_quality !== "string" ||
    !snapshot.summary ||
    typeof snapshot.summary !== "object" ||
    typeof snapshot.summary.total !== "number" ||
    !Array.isArray(snapshot.stocks)
  ) {
    throw new Error(
      "upstream JSON missing required fields: snapshot_time/system_quality/summary.total/stocks",
    );
  }

  if (snapshot.summary.total !== snapshot.stocks.length) {
    throw new Error(
      `summary.total=${snapshot.summary.total} but stocks.length=${snapshot.stocks.length}`,
    );
  }
}

function createIssueBody(payload: BridgePayload): string {
  return [
    "# A/H 行情计划任务数据桥",
    "",
    "> 机器数据。由 Cloudflare Worker Cron 自动刷新；GitHub Actions 仅用于手工补跑，供 ChatGPT Scheduled Task 通过 GitHub 连接器读取。请勿手工编辑 JSON 区域。",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "cn-hk-quotes-cloudflare-bridge/1.0",
  };
}

async function fetchUpstreamSnapshot(source: string): Promise<QuoteSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const separator = source.includes("?") ? "&" : "?";
    const response = await fetch(`${source}${separator}_bridge_ts=${Date.now()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "cn-hk-quotes-cloudflare-bridge/1.0",
      },
      signal: controller.signal,
    });
    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      throw new Error(`upstream returned invalid JSON: ${raw.slice(0, 500)}`);
    }

    validateSnapshot(snapshot);
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

export async function updateQuoteBridge(
  env: Env,
  workflowRunId: string,
  workflowRunAttempt = "1",
): Promise<BridgePayload> {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN secret is not configured");
  }

  const issueUrl = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${GITHUB_ISSUE_NUMBER}`;
  const currentResponse = await fetch(issueUrl, {
    method: "GET",
    headers: githubHeaders(env.GITHUB_TOKEN),
  });
  if (!currentResponse.ok) {
    const detail = (await currentResponse.text()).slice(0, 500);
    throw new Error(`GitHub issue read failed: HTTP ${currentResponse.status}: ${detail}`);
  }

  const currentIssue = (await currentResponse.json()) as GitHubIssue;
  const previous = parsePreviousBridge(currentIssue.body);
  const now = new Date().toISOString();
  let payload: BridgePayload;

  try {
    const snapshot = await fetchUpstreamSnapshot(PORTFOLIO_QUOTES_URL);
    payload = {
      schema_version: "1.0",
      bridge: {
        last_attempt_at: now,
        last_attempt_status: "SUCCESS",
        last_success_at: now,
        workflow_run_id: workflowRunId,
        workflow_run_attempt: workflowRunAttempt,
        source: PORTFOLIO_QUOTES_URL,
        error: null,
      },
      snapshot,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    payload = {
      schema_version: "1.0",
      bridge: {
        last_attempt_at: now,
        last_attempt_status: "FAIL",
        last_success_at: previous.lastSuccessAt,
        workflow_run_id: workflowRunId,
        workflow_run_attempt: workflowRunAttempt,
        source: PORTFOLIO_QUOTES_URL,
        error: errorMessage,
      },
      snapshot: previous.snapshot,
    };
  }

  const updateResponse = await fetch(issueUrl, {
    method: "PATCH",
    headers: {
      ...githubHeaders(env.GITHUB_TOKEN),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: createIssueBody(payload) }),
  });
  if (!updateResponse.ok) {
    const detail = (await updateResponse.text()).slice(0, 500);
    throw new Error(`GitHub issue update failed: HTTP ${updateResponse.status}: ${detail}`);
  }

  return payload;
}

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
      inputSchema: z.object({}),
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
                  message: error instanceof Error ? error.message : String(error),
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
  async scheduled(controller: ScheduledController, env: Env) {
    const payload = await updateQuoteBridge(env, `cron:${controller.cron}`);
    console.log(
      JSON.stringify({
        bridge_status: payload.bridge.last_attempt_status,
        snapshot_time: payload.snapshot?.snapshot_time ?? null,
        system_quality: payload.snapshot?.system_quality ?? null,
        error: payload.bridge.error,
      }),
    );
  },
} satisfies ExportedHandler<Env>;
