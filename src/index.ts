import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { githubBearerToken, verifyGithubAccessToken } from "./github-auth";
import {
	readLiveUniverse,
	resolveLiveUniverseFreshness,
	writeLiveUniverse,
	type StoredLiveUniverse,
} from "./live-universe";
import {
	LiveCoverageError,
	isLiveOverlayEnabled,
	projectCallerSnapshot,
	redactInstrumentCodes,
	resolveLiveOverlayStatus,
	type LiveOverlayStatus,
} from "./live-overlay";
import {
	PORTFOLIO_STATUS_MAX_PAYLOAD_BYTES,
	readPortfolioStatus,
	resolvePortfolioPresentation,
	writePortfolioStatus,
	type PortfolioAnchorView,
	type PortfolioPresentation,
	type StoredPortfolioStatus,
} from "./portfolio-status";
import { getSnapshotCounts, validateSnapshot, type QuoteSnapshot } from "./portfolio-validation";

const PORTFOLIO_QUOTES_URL =
	"https://cn-hk-quotes-proxy.zhushihao710.workers.dev/api/portfolio-quotes";
const PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL =
	"https://cn-hk-quotes.zhushihao710.chatgpt.site/api/portfolio-quotes";
const GITHUB_REPOSITORY = "zhushihao/cn-hk-quotes-mcp";
const GITHUB_ISSUE_NUMBER = 1;
const GITHUB_API_VERSION = "2022-11-28";

interface Env {
	GITHUB_TOKEN: string;
	PORTFOLIO_UNIVERSE?: KVNamespace;
	PORTFOLIO_UNIVERSE_TOKEN?: string;
}

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

function createIssueBody(payload: BridgePayload): string {
	return [
		"# A/H 行情计划任务数据桥",
		"",
		"> 机器数据。由 Cloudflare Worker Cron 自动刷新；GitHub Actions 仅用于手工补跑。LIVE 持仓真相不再由固定 23/13 名单维护，而由 Cloudflare 的受鉴权 quote-universe/1 动态层承接；请勿手工编辑 JSON 区域。",
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
		cron: workflowRunId.startsWith("cron:")
			? workflowRunId.slice("cron:".length) || "manual-test"
			: workflowRunId === "test:scheduled"
				? "manual-test"
				: "manual",
	};
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/authorization\s*:\s*[^,\s]+/gi, "authorization: [REDACTED]")
		.replace(/bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
		.slice(0, 500);
}

/**
 * 面向调用方的错误文本（issue #15 / D-1 要求 2）：
 *
 * 在 `safeErrorMessage()`（遮蔽凭据）之上再去掉证券代码形态——coverage 缺失、
 * identity、stale 等任何出口都不得带出真实代码，缺失**数量**保留。
 * `safeErrorMessage()` 本身仍是服务端日志口径（可保留明细）。
 */
function clientFacingErrorMessage(error: unknown): string {
	return redactInstrumentCodes(safeErrorMessage(error));
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

/** KV 中的 LIVE 面（投影 + 状态件）与推导出的消费侧呈现口径。 */
type LivePresentation = {
	universe: StoredLiveUniverse | null;
	status: StoredPortfolioStatus | null;
	presentation: PortfolioPresentation;
};

async function readPortfolioStatusSafe(kv: KVNamespace): Promise<StoredPortfolioStatus | null> {
	try {
		return await readPortfolioStatus(kv);
	} catch {
		// 状态件损坏 / 非法 → 按「无件」口径保守呈现（C-3），不把消费面拖入硬失败。
		return null;
	}
}

/**
 * C-4/C-5 的单一出口：读 KV 的投影与状态件，解析双轨新鲜度锚，推导三态呈现口径。
 *
 * - `tolerateUnreadableUniverse`：诊断面（`/api/control-plane-status`）沿用既有
 *   「读失败 = present=false」口径；供数面保持 fail-closed（读失败向上抛，与迁移前一致）。
 */
async function resolveLivePresentation(
	kv: KVNamespace | undefined,
	now = new Date(),
	options: { tolerateUnreadableUniverse?: boolean } = {},
): Promise<LivePresentation> {
	if (!kv) {
		return {
			universe: null,
			status: null,
			presentation: resolvePortfolioPresentation({
				universePresent: false,
				universeContentHash: null,
				universeManifestHash: null,
				status: null,
				anchor: null,
				now,
			}),
		};
	}
	let universe: StoredLiveUniverse | null = null;
	if (options.tolerateUnreadableUniverse) {
		try {
			universe = await readLiveUniverse(kv);
		} catch {
			universe = null;
		}
	} else {
		universe = await readLiveUniverse(kv);
	}
	const status = await readPortfolioStatusSafe(kv);
	// LRCCA 缺失（无状态件 / 不可读 / 字段为空）→ generated_at 兜底锚（anchor_fallback=true）。
	let anchorView: PortfolioAnchorView | null = null;
	if (universe) {
		const anchor = resolveLiveUniverseFreshness(universe, {
			lrcca: status?.last_real_complete_confirmed_at ?? null,
			now,
		});
		anchorView = {
			anchor: anchor.anchor,
			anchor_fallback: anchor.anchor_fallback,
			fresh: anchor.fresh,
		};
	}
	const presentation = resolvePortfolioPresentation({
		universePresent: universe !== null,
		universeContentHash: universe?.content_hash ?? null,
		universeManifestHash: universe?.source_manifest_hash ?? null,
		status,
		anchor: anchorView,
		now,
	});
	return { universe, status, presentation };
}

/**
 * `fetchUpstreamSnapshot()` 的 LIVE 叠加门（D-1 选项 A）。
 *
 * 缺省 `SKIPPED_UNAUTHORIZED` 是**有意的 fail-closed**：只有显式传入 `ENABLED`
 * 的调用方才可能应用 LIVE 叠加。`updateQuoteBridge()`（旧行情桥）本就不传 `env`，
 * 叠加在结构上不可能发生（见 `PORTFOLIO_SYNC.md`「与旧桥的兼容」）。
 */
type UpstreamFetchOptions = {
	liveOverlayStatus?: LiveOverlayStatus;
};

async function fetchUpstreamSnapshot(
	sources: string[],
	context: BridgeStageContext,
	env?: Env,
	options: UpstreamFetchOptions = {},
): Promise<UpstreamSnapshotResult> {
	const liveOverlayStatus = options.liveOverlayStatus ?? "SKIPPED_UNAUTHORIZED";
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
			let projectedSnapshot = snapshot;
			let liveUniverseHash: string | null = null;
			let liveUniverseCoverage = "NOT_CONFIGURED";
			let liveUniverseState: string | null = null;
			let liveUniverseAnchor: string | null = null;
			let liveUniverseAnchorFallback: boolean | null = null;
			if (env?.PORTFOLIO_UNIVERSE) {
				// D-1 选项 A（issue #15）：门未放行（匿名 / 错带 token / 服务端未配置 token）时
				// **不读 KV、不判三态、不报错** —— 与「无 universe」同路径（legacy 目录视图），
				// 降级原因随 `control_plane_status.live_overlay_status` 外发。
				const live = isLiveOverlayEnabled(liveOverlayStatus)
					? await resolveLivePresentation(env.PORTFOLIO_UNIVERSE, new Date())
					: null;
				// C-4：新鲜度锚已迁到状态件 LRCCA（缺失/不可读时回退 generated_at）。
				liveUniverseState = live?.presentation.portfolio_state ?? null;
				liveUniverseAnchor = live?.presentation.freshness_anchor ?? null;
				liveUniverseAnchorFallback = live?.presentation.freshness_anchor_fallback ?? null;
				liveUniverseHash = live?.universe?.content_hash ?? null;
				const projected = projectCallerSnapshot({
					snapshot,
					liveOverlayStatus,
					universeBound: true,
					universe: live?.universe ?? null,
					// C-5 / J-11：PORTFOLIO_UNKNOWN 不应用 LIVE overlay——回退静态目录，
					// 不把旧投影当「当前持仓」用，也不报错（由 control_plane_status 标记）。
					applyOverlay: live?.presentation.apply_overlay ?? false,
				});
				projectedSnapshot = projected.snapshot;
				liveUniverseCoverage = projected.coverage;
			}
			const counts = getSnapshotCounts(projectedSnapshot);
			logBridgeStage(context, "payload_validation_success", {
				stock_count: counts.total,
				active_quote_count: counts.activeQuoteTotal,
				active_holding_count: counts.activeHoldingTotal,
				watch_count: counts.watchTotal,
				portfolio_version: projectedSnapshot.portfolio_version,
				live_overlay_status: liveOverlayStatus,
				live_universe_hash: liveUniverseHash,
				live_universe_coverage: liveUniverseCoverage,
				live_universe_state: liveUniverseState,
				live_universe_anchor: liveUniverseAnchor,
				live_universe_anchor_fallback: liveUniverseAnchorFallback,
				exited_watch_count: counts.exitedWatchTotal,
				mapping_count: counts.mappingTotal,
				core_count: counts.coreTotal,
				growth_count: counts.growthTotal,
			});
			return { snapshot: projectedSnapshot, source };
		} catch (error) {
			if (error instanceof LiveCoverageError) {
				// D-1 要求 2：面向调用方的文本只出数量（error.message 已是数量文本），
				// 逐代码明细只进服务端结构化日志。
				logBridgeStage(context, "live_universe_coverage_incomplete", {
					active_count: error.activeCount,
					quoted_active_count: error.quotedActiveCount,
					missing_active_count: error.missingCount,
					missing_active: error.missingActive,
				});
				throw new BridgeError("live_universe_coverage", error.message);
			}
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
		portfolio_version: payload.snapshot?.portfolio_version ?? null,
		snapshot_time: payload.snapshot?.snapshot_time ?? null,
		stock_count: payload.snapshot?.stocks.length ?? 0,
	});

	return payload;
}

/**
 * MCP server 工厂（每个 HTTP 请求构造一次，`ctx.requestInfo` 即原始请求）。
 *
 * `liveOverlayStatus` 缺省 `SKIPPED_UNAUTHORIZED` 是**有意的 fail-closed**：
 * 只有 `fetch()` 路由把请求头判定结果显式传进来时才可能应用 LIVE 叠加。
 */
function createServer(
	env?: Env,
	liveOverlayStatus: LiveOverlayStatus = "SKIPPED_UNAUTHORIZED",
) {
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
				"获取 A/H 结构化行情快照。桥接层不再用固定 23/13 标的名单校验；LIVE 动态持仓由 Cloudflare quote-universe/1 层独立驱动，且**仅对携带有效 PORTFOLIO_UNIVERSE_TOKEN bearer 的调用方生效**（匿名调用返回 legacy 目录视图，并在 control_plane_status.live_overlay_status 标注 SKIPPED_*）。返回价格、涨跌幅、成交量、成交额、日内高低点、市场状态、行情时间、来源、质量状态、分组、Portfolio Status 和映射关系等。仅用于只读行情查询。",
			inputSchema: z.object({}),
		},
		async () => {
			const context = bridgeContext("mcp:get_portfolio_quotes");
			try {
				const upstream = await fetchUpstreamSnapshot(
					[PORTFOLIO_QUOTES_URL, PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL],
					context,
					env,
					{ liveOverlayStatus },
				);
				const controlPlaneStatus = env
					? {
						...(await getControlPlaneStatus(env)),
						live_overlay_status: liveOverlayStatus,
					}
					: {
						status: "DEGRADED",
						github_private_read: false,
						kv_bound: false,
						universe_present: false,
						universe_fresh: false,
						portfolio_state: "PORTFOLIO_UNKNOWN",
						stale: true,
						freshness_anchor: null,
						freshness_anchor_fallback: false,
						mode: "LEGACY_FALLBACK",
						live_overlay_status: liveOverlayStatus,
					};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ ...upstream.snapshot, control_plane_status: controlPlaneStatus },
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				logBridgeFailure(context, error, "upstream_fetch");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: "UPSTREAM_FETCH_ERROR",
									message: clientFacingErrorMessage(error),
								},
								null,
								2,
							),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"get_control_plane_status",
		{
			description:
				"只读检查 LIVE 持仓私有控制面是否可用。仅返回私有 GitHub 可读、Cloudflare KV binding、universe 是否存在/新鲜、当前模式和本请求的 LIVE 叠加门判定（live_overlay_status）；不返回持仓代码、数量、hash 或凭据。",
			inputSchema: z.object({}),
		},
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							...(await getControlPlaneStatus(env ?? ({} as Env))),
							live_overlay_status: liveOverlayStatus,
						},
						null,
						2,
					),
				},
			],
		}),
	);

	return server;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

/**
 * 请求级 LIVE 叠加门判定（D-1 选项 A）：取 `Authorization` 头与既有
 * `PORTFOLIO_UNIVERSE_TOKEN` 比对。判定实现与写入端点鉴权**同源**
 * （`live-overlay.resolveLiveOverlayStatus()`），此处只做请求对象到原始头的适配。
 */
function requestLiveOverlayStatus(request: Request | undefined, env: Env): LiveOverlayStatus {
	return resolveLiveOverlayStatus(
		request?.headers.get("Authorization") ?? null,
		env.PORTFOLIO_UNIVERSE_TOKEN,
	);
}

/** 沿用既有口径：token 未配置或请求头不匹配 → 未授权（fail-closed，`!== "ENABLED"`）。 */
function isUniverseAuthorized(request: Request, env: Env): boolean {
	return isLiveOverlayEnabled(requestLiveOverlayStatus(request, env));
}

async function handleUniverseApi(request: Request, env: Env): Promise<Response> {
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	if (!isUniverseAuthorized(request, env)) {
		return jsonResponse({ error: "UNAUTHORIZED" }, 401);
	}
	if (request.method === "GET") {
		try {
			const universe = await readLiveUniverse(env.PORTFOLIO_UNIVERSE);
			return universe ? jsonResponse(universe) : jsonResponse({ error: "NO_LIVE_UNIVERSE" }, 404);
		} catch (error) {
			return jsonResponse({ error: "LIVE_UNIVERSE_READ_FAILED", message: clientFacingErrorMessage(error) }, 500);
		}
	}
	if (request.method !== "POST") {
		return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	}

	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return jsonResponse({ error: "BODY_READ_FAILED" }, 400);
	}
	if (new TextEncoder().encode(raw).byteLength > 32_768) {
		return jsonResponse({ error: "PAYLOAD_TOO_LARGE" }, 413);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ error: "INVALID_JSON" }, 400);
	}
	try {
		const stored = await writeLiveUniverse(env.PORTFOLIO_UNIVERSE, payload);
		return jsonResponse({
			status: "SUCCESS",
			schema_version: stored.schema_version,
			content_hash: stored.content_hash,
			generated_at: stored.generated_at,
			source_manifest_hash: stored.source_manifest_hash,
			received_at: stored.received_at,
			active_count: stored.active.length,
		});
	} catch (error) {
		return jsonResponse({ error: "INVALID_QUOTE_UNIVERSE", message: clientFacingErrorMessage(error) }, 400);
	}
}

async function getControlPlaneStatus(env: Env) {
	const live = await resolveLivePresentation(env.PORTFOLIO_UNIVERSE, new Date(), {
		tolerateUnreadableUniverse: true,
	});
	const universePresent = live.universe !== null;
	// 双轨锚：LRCCA 优先，缺失时回退 generated_at（C-4），口径仍是既有 10 天可用窗口。
	const universeFresh = live.presentation.fresh;
	return {
		status: universePresent && universeFresh ? "OK" : "PENDING",
		ingest_mode: "GITHUB_VERIFIED_PUSH",
		github_private_read: false,
		kv_bound: Boolean(env.PORTFOLIO_UNIVERSE),
		universe_present: universePresent,
		universe_fresh: universeFresh,
		// C-3：只出三态枚举词（无代码 / 数量 / hash）；无件 / 损坏 / 交叉不一致按保守态呈现。
		portfolio_state: live.presentation.portfolio_state,
		stale: live.presentation.stale,
		freshness_anchor: live.presentation.freshness_anchor,
		freshness_anchor_fallback: live.presentation.freshness_anchor_fallback,
		mode: universePresent ? "LIVE_DYNAMIC" : "LEGACY_FALLBACK",
	};
}

async function handleControlPlaneStatus(env: Env): Promise<Response> {
	const payload = await getControlPlaneStatus(env);
	return jsonResponse(payload, payload.kv_bound ? 200 : 503);
}

async function handleGithubAuthProbe(request: Request): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	try {
		await verifyGithubAccessToken(githubBearerToken(request));
		return jsonResponse({ status: "OK", identity: "GITHUB_VERIFIED" });
	} catch (error) {
		return jsonResponse({ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) }, 401);
	}
}

async function handleGithubAuthUniverse(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	try {
		await verifyGithubAccessToken(githubBearerToken(request));
	} catch (error) {
		return jsonResponse({ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) }, 401);
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return jsonResponse({ error: "BODY_READ_FAILED" }, 400);
	}
	if (new TextEncoder().encode(raw).byteLength > 32_768) {
		return jsonResponse({ error: "PAYLOAD_TOO_LARGE" }, 413);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ error: "INVALID_JSON" }, 400);
	}
	try {
		const stored = await writeLiveUniverse(env.PORTFOLIO_UNIVERSE, payload);
		return jsonResponse({
			status: "SUCCESS",
			content_hash: stored.content_hash,
			generated_at: stored.generated_at,
			received_at: stored.received_at,
			active_count: stored.active.length,
		});
	} catch (error) {
		return jsonResponse({ error: "INVALID_QUOTE_UNIVERSE", message: clientFacingErrorMessage(error) }, 400);
	}
}

/**
 * C-1：`POST /api/github-auth/portfolio-status` —— 接收 LIVE 侧状态件。
 *
 * 失败语义与 `/api/github-auth/quote-universe` 完全同款（401 / 413 / 400），
 * 写入前全量校验，非法件拒写且旧件保留（LKG 语义，见 writePortfolioStatus）。
 * 写入内容为状态件原样（LIVE 是三态的权威计算方，J-4）；Worker 的保守复核
 * 发生在**读取**侧（resolveLivePresentation），不回写 KV。
 */
async function handleGithubAuthPortfolioStatus(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	try {
		await verifyGithubAccessToken(githubBearerToken(request));
	} catch (error) {
		return jsonResponse({ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) }, 401);
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return jsonResponse({ error: "BODY_READ_FAILED" }, 400);
	}
	if (new TextEncoder().encode(raw).byteLength > PORTFOLIO_STATUS_MAX_PAYLOAD_BYTES) {
		return jsonResponse({ error: "PAYLOAD_TOO_LARGE" }, 413);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ error: "INVALID_JSON" }, 400);
	}
	try {
		const stored = await writePortfolioStatus(env.PORTFOLIO_UNIVERSE, payload);
		return jsonResponse({
			status: "SUCCESS",
			schema_version: stored.schema_version,
			state: stored.state,
			generated_at: stored.generated_at,
			last_real_complete_confirmed_at: stored.last_real_complete_confirmed_at,
			universe_content_hash: stored.universe_content_hash,
			source_manifest_hash: stored.source_manifest_hash,
			received_at: stored.received_at,
		});
	} catch (error) {
		return jsonResponse({ error: "INVALID_PORTFOLIO_STATUS", message: clientFacingErrorMessage(error) }, 400);
	}
}

async function handleDynamicPortfolioQuotes(request: Request, env: Env): Promise<Response> {
	if (!isUniverseAuthorized(request, env)) {
		return jsonResponse({ error: "UNAUTHORIZED" }, 401);
	}
	if (!env.PORTFOLIO_UNIVERSE) {
		return jsonResponse({ error: "PORTFOLIO_UNIVERSE_KV_NOT_CONFIGURED" }, 503);
	}
	const context = bridgeContext("http:dynamic-portfolio-quotes");
	try {
		// C-4/C-5：本端点是「LIVE 动态投影」诊断面，状态未知时不静默返回静态目录。
		const live = await resolveLivePresentation(env.PORTFOLIO_UNIVERSE, new Date());
		if (!live.universe) return jsonResponse({ error: "NO_LIVE_UNIVERSE" }, 503);
		if (!live.presentation.fresh) {
			return jsonResponse(
				{ error: "LIVE_UNIVERSE_STALE", portfolio_state: live.presentation.portfolio_state },
				503,
			);
		}
		if (!live.presentation.apply_overlay) {
			return jsonResponse(
				{ error: "PORTFOLIO_UNKNOWN", portfolio_state: live.presentation.portfolio_state },
				503,
			);
		}
		const upstream = await fetchUpstreamSnapshot(
			[PORTFOLIO_QUOTES_URL, PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL],
			context,
			env,
			// 本端点已在上面用同一入口鉴权（未授权直接 401），故门必为放行态。
			{ liveOverlayStatus: requestLiveOverlayStatus(request, env) },
		);
		return jsonResponse(upstream.snapshot);
	} catch (error) {
		logBridgeFailure(context, error, "dynamic_portfolio_quotes");
		return jsonResponse({ error: "PORTFOLIO_QUOTES_UNAVAILABLE", message: clientFacingErrorMessage(error) }, 502);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/api/github-auth/probe") return handleGithubAuthProbe(request);
		if (url.pathname === "/api/github-auth/quote-universe") return handleGithubAuthUniverse(request, env);
		if (url.pathname === "/api/github-auth/portfolio-status") {
			return handleGithubAuthPortfolioStatus(request, env);
		}
		if (url.pathname === "/api/control-plane-status" && request.method === "GET") {
			return handleControlPlaneStatus(env);
		}
		if (url.pathname === "/api/quote-universe") return handleUniverseApi(request, env);
		if (url.pathname === "/api/portfolio-quotes") return handleDynamicPortfolioQuotes(request, env);
		// MCP 面（含 `get_portfolio_quotes`）：按**本请求**的 Authorization 头判定 LIVE 叠加门
		// （D-1 选项 A）。工厂按请求构造 server，故 `ctx.requestInfo` 就是当前请求。
		const handler = createMcpHandler((ctx) =>
			createServer(env, requestLiveOverlayStatus(ctx.requestInfo, env)),
		);
		return handler(request, env, ctx);
	},
	async scheduled(controller: ScheduledController, env: Env) {
		const runId = controller.cron ? `cron:${controller.cron}` : "test:scheduled";
		const context = bridgeContext(runId);
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
