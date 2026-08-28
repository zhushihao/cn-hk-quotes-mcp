import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const PORTFOLIO_QUOTES_URL =
	"https://cn-hk-quotes-proxy.zhushihao710.workers.dev/api/portfolio-quotes";
const PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL =
	"https://cn-hk-quotes.zhushihao710.chatgpt.site/api/portfolio-quotes";
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

type UpstreamSnapshotResult = {
	snapshot: QuoteSnapshot;
	source: string;
};

type BridgeStageContext = {
	runId: string;
	cron: string;
};

class BridgeError extends Error {
	readonly stage: string;
	readonly httpStatus: number | null;

	constructor(stage: string, message: string, httpStatus: number | null = null) {
		super(message);
		this.name = "BridgeError";
		this.stage = stage;
		this.httpStatus = httpStatus;
	}
}

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

function bridgeContext(workflowRunId: string): BridgeStageContext {
	return {
		runId: workflowRunId,
		cron: workflowRunId.startsWith("cron:") ? workflowRunId.slice("cron:".length) : "manual",
	};
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/authorization\s*:\s*[^,\s]+/gi, "authorization: [REDACTED]")
		.replace(/bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
		.slice(0, 500);
}

function logBridgeStage(
	context: BridgeStageContext,
	stage: string,
	details: Record<string, unknown> = {},
): void {
	console.log(
		JSON.stringify({
			event: "quote_bridge",
			timestamp: new Date().toISOString(),
			run_id: context.runId,
			cron: context.cron,
			stage,
			...details,
		}),
	);
}

function logBridgeFailure(
	context: BridgeStageContext,
	error: unknown,
	fallbackStage: string,
): void {
	const bridgeError = error instanceof BridgeError ? error : null;
	logBridgeStage(context, "bridge_failed", {
		failed_stage: bridgeError?.stage ?? fallbackStage,
		http_status: bridgeError?.httpStatus ?? null,
		error_type: error instanceof Error ? error.name : typeof error,
		error_message: safeErrorMessage(error),
	});
}

async function fetchUpstreamSnapshot(
	sources: string[],
	context: BridgeStageContext,
): Promise<UpstreamSnapshotResult> {
	let lastError: BridgeError | null = null;

	for (const [index, source] of sources.entries()) {
		logBridgeStage(context, "upstream_fetch_start", {
			source_url: source,
		});
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
				throw new BridgeError(
					"upstream_fetch",
					`upstream request failed with HTTP ${response.status}`,
					response.status,
				);
			}

			let snapshot: unknown;
			try {
				snapshot = JSON.parse(raw);
			} catch {
				throw new BridgeError("upstream_fetch", "upstream returned invalid JSON");
			}

			logBridgeStage(context, "upstream_fetch_success", {
				http_status: response.status,
				source_url: source,
			});
			validateSnapshot(snapshot);
			logBridgeStage(context, "payload_validation_success", {
				stock_count: snapshot.stocks.length,
			});
			return { snapshot, source };
		} catch (error) {
			lastError =
				error instanceof BridgeError
					? error
					: new BridgeError("upstream_fetch", safeErrorMessage(error));
			const canRetryWithPublicSite =
				lastError.httpStatus === 404 && index < sources.length - 1;
			if (!canRetryWithPublicSite) {
				throw lastError;
			}
			logBridgeStage(context, "upstream_fetch_retry", {
				failed_source_url: source,
				http_status: lastError.httpStatus,
				next_source_url: sources[index + 1],
			});
		} finally {
			clearTimeout(timer);
		}
	}

	throw lastError ?? new BridgeError("upstream_fetch", "no upstream source configured");
}

export async function updateQuoteBridge(
	env: Env,
	workflowRunId: string,
	workflowRunAttempt = "1",
): Promise<BridgePayload> {
	const context = bridgeContext(workflowRunId);

	if (!env.GITHUB_TOKEN) {
		throw new BridgeError("token_check", "GITHUB_TOKEN secret is not configured");
	}

	const issueUrl = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${GITHUB_ISSUE_NUMBER}`;
	logBridgeStage(context, "issue_get_start");
	let currentResponse: Response;
	try {
		currentResponse = await fetch(issueUrl, {
			method: "GET",
			headers: githubHeaders(env.GITHUB_TOKEN),
		});
	} catch (error) {
		throw new BridgeError("issue_get", safeErrorMessage(error));
	}
	if (!currentResponse.ok) {
		throw new BridgeError(
			"issue_get",
			`GitHub issue read failed with HTTP ${currentResponse.status}`,
			currentResponse.status,
		);
	}
	logBridgeStage(context, "issue_get_success", {
		http_status: currentResponse.status,
	});

	const currentIssue = (await currentResponse.json()) as GitHubIssue;
	const previous = parsePreviousBridge(currentIssue.body);
	const now = new Date().toISOString();
	let payload: BridgePayload;
	let upstreamError: BridgeError | null = null;

	try {
		const upstream = await fetchUpstreamSnapshot(
			[PORTFOLIO_QUOTES_URL, PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL],
			context,
		);
		payload = {
			schema_version: "1.0",
			bridge: {
				last_attempt_at: now,
				last_attempt_status: "SUCCESS",
				last_success_at: now,
				workflow_run_id: workflowRunId,
				workflow_run_attempt: workflowRunAttempt,
				source: upstream.source,
				error: null,
			},
			snapshot: upstream.snapshot,
		};
	} catch (error) {
		upstreamError =
			error instanceof BridgeError
				? error
				: new BridgeError("upstream_fetch", safeErrorMessage(error));
		payload = {
			schema_version: "1.0",
			bridge: {
				last_attempt_at: now,
				last_attempt_status: "FAIL",
				last_success_at: previous.lastSuccessAt,
				workflow_run_id: workflowRunId,
				workflow_run_attempt: workflowRunAttempt,
				source: PORTFOLIO_QUOTES_URL,
				error: `${upstreamError.name}: ${upstreamError.message}`,
			},
			snapshot: previous.snapshot,
		};
	}

	logBridgeStage(context, "issue_patch_start");
	let updateResponse: Response;
	try {
		updateResponse = await fetch(issueUrl, {
			method: "PATCH",
			headers: {
				...githubHeaders(env.GITHUB_TOKEN),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ body: createIssueBody(payload) }),
		});
	} catch (error) {
		throw new BridgeError("issue_patch", safeErrorMessage(error));
	}
	if (!updateResponse.ok) {
		throw new BridgeError(
			"issue_patch",
			`GitHub issue update failed with HTTP ${updateResponse.status}`,
			updateResponse.status,
		);
	}
	logBridgeStage(context, "issue_patch_success", {
		http_status: updateResponse.status,
	});

	if (upstreamError) {
		throw upstreamError;
	}

	logBridgeStage(context, "bridge_success", {
		snapshot_time: payload.snapshot?.snapshot_time ?? null,
		stock_count: payload.snapshot?.stocks.length ?? 0,
	});

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
		const context = bridgeContext(`cron:${controller.cron}`);
		logBridgeStage(context, "scheduled_enter");

		try {
			const payload = await updateQuoteBridge(env, context.runId);
			logBridgeStage(context, "scheduled_complete", {
				bridge_status: payload.bridge.last_attempt_status,
				snapshot_time: payload.snapshot?.snapshot_time ?? null,
				system_quality: payload.snapshot?.system_quality ?? null,
			});
		} catch (error) {
			logBridgeFailure(context, error, "scheduled");
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;
