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
import { recordPortfolioUniverseObservation, type PortfolioDeltaState } from "./portfolio-delta";
import {
	LiveCoverageError,
	isLiveOverlayEnabled,
	projectCallerSnapshot,
	redactInstrumentCodes,
	resolveLiveOverlayStatus,
	type LiveOverlayStatus,
} from "./live-overlay";
import {
	DynamicQuoteError,
	createTencentQuoteProvider,
	fetchDynamicQuoteRows,
	mergeDynamicQuoteRows,
} from "./dynamic-quotes";
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
import { toPublicQuoteSnapshot, type PublicQuoteSnapshot } from "./quote-projections";
import { ingestResearchReplicaRecord, type ResearchReplicaStorage } from "./research-replica.ts";
import { CollectorResearchRemoteAdapter } from "./research-remote-adapter.ts";
import { ResearchBoundaryError } from "./research-outbound-v2.ts";

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
	/** 旧行情 origin（cn-hk-quotes-proxy / chatgpt.site）启用 Cloudflare Access 后注入。 */
	CF_ACCESS_CLIENT_ID?: string;
	CF_ACCESS_CLIENT_SECRET?: string;
	RESEARCH_REPLICA?: D1Database;
	RESEARCH_OBJECTS?: R2Bucket;
	RESEARCH_REPLICA_INGEST_TOKEN?: string;
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
	snapshot: QuoteSnapshot | PublicQuoteSnapshot | null;
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
	snapshot: QuoteSnapshot | PublicQuoteSnapshot | null;
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
		"> 机器数据。由 Cloudflare Worker Cron 自动刷新；GitHub Actions 仅用于手工补跑。本载荷为 quote-only（public_quote_snapshot/1），不含任何持仓身份/数量字段；LIVE 持仓真相由受鉴权 quote-universe/1 动态层承接；请勿手工编辑 JSON 区域。",
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
 * C1 dynamic quote completion is deliberately before the existing coverage
 * gate.  The gate remains the final authority: a provider error, malformed
 * code, or partial batch never contributes rows and therefore never turns an
 * incomplete LIVE universe into a successful response.
 */
async function completeMissingLiveQuotes(
	snapshot: QuoteSnapshot,
	universe: StoredLiveUniverse,
): Promise<QuoteSnapshot> {
	const catalogKeys = new Set(snapshot.stocks.map((row) => `${row.market}:${row.code}`));
	const missing = universe.active.filter(
		(identity) => !catalogKeys.has(`${identity.market}:${identity.code}`),
	);
	if (missing.length === 0) return snapshot;
	try {
		const batch = await fetchDynamicQuoteRows(missing, {
			fetchQuote: createTencentQuoteProvider(),
		});
		return mergeDynamicQuoteRows(snapshot, batch);
	} catch (error) {
		if (error instanceof DynamicQuoteError) {
			throw new BridgeError("dynamic_quote_fetch", error.code);
		}
		throw error;
	}
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
			// 旧行情 origin（proxy/chatgpt.site）启用 Cloudflare Access 服务令牌后，
			// 内部抓取凭 CF-Access-Client-Id/Secret 通过边（issue #7 Step 3）；
			// 绑定未配置时保持匿名（本地 dev / Access 未开启阶段），凭据不进日志。
			const accessHeaders: Record<string, string> = {};
			if (env?.CF_ACCESS_CLIENT_ID && env?.CF_ACCESS_CLIENT_SECRET) {
				accessHeaders["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
				accessHeaders["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
			}
			const response = await fetch(`${source}${separator}_bridge_ts=${Date.now()}`, {
				method: "GET",
				headers: {
					Accept: "application/json",
					"Cache-Control": "no-cache",
					"User-Agent": "cn-hk-quotes-cloudflare-bridge/1.0",
					...accessHeaders,
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
				const snapshotForOverlay =
					live?.universe && live.presentation.apply_overlay
						? await completeMissingLiveQuotes(snapshot, live.universe)
						: snapshot;
				const projected = projectCallerSnapshot({
					snapshot: snapshotForOverlay,
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

async function fetchPublicQuoteSnapshot(
	context: BridgeStageContext,
	env?: Env,
): Promise<PublicQuoteSnapshot> {
	// 公开行情 pickup 仍指向旧 Worker 的 chatgpt.site 公开入口（public host，
	// issue #7 Step 4 起由 Cloudflare Access + 服务令牌保护），投影为 quote-only 后外发。
	const upstream = await fetchUpstreamSnapshot(
		[PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL],
		context,
		env,
	);
	return toPublicQuoteSnapshot(upstream.snapshot);
}

const PUBLIC_QUOTES_UNAVAILABLE_MESSAGE = "Public quote snapshot is unavailable";

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
		// env 仅用于旧 origin 的 Access 服务令牌（Step 3）；不传叠加门参，
		// 叠加（LIVE overlay / KV 读取）在 cron 路径结构上仍不可能发生。
		const upstream = await fetchUpstreamSnapshot(
			[PORTFOLIO_QUOTES_URL, PORTFOLIO_QUOTES_PUBLIC_FALLBACK_URL],
			context,
			env,
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
			// Issue #1 是公开面（repo 为 public）：载荷一律投影为 quote-only。
			snapshot: toPublicQuoteSnapshot(upstream.snapshot),
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
			// 失败回退的历史快照同样投影，防止把身份字段重新写回公开 issue。
			snapshot: previous.snapshot ? toPublicQuoteSnapshot(previous.snapshot) : null,
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
		// 旧（v4 富件）与新（public_quote_snapshot/1）两种载荷各自带版本字段。
		portfolio_version:
			payload.snapshot == null
				? null
				: "portfolio_version" in payload.snapshot
					? payload.snapshot.portfolio_version
					: payload.snapshot.schema_version,
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
function createServer(env?: Env, liveOverlayStatus: LiveOverlayStatus = "SKIPPED_UNAUTHORIZED") {
	const server = new McpServer({
		name: "QuantPro Collector",
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
				"获取 A/H 结构化行情快照。LIVE 动态持仓由 Cloudflare quote-universe/1 层独立驱动，且**仅对携带有效 PORTFOLIO_UNIVERSE_TOKEN bearer 的调用方生效**（匿名调用返回 quote-only 投影视图，不含任何持仓身份/数量字段，并在 control_plane_status.live_overlay_status 标注 SKIPPED_*）。返回价格、涨跌幅、成交量、成交额、日内高低点、市场状态、行情时间、来源、质量状态、分组、Portfolio Status 和映射关系等。仅用于只读行情查询。",
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
				// 双契约（issue #7 Step 2）：有效 bearer 保留完整 LIVE 语义；
				// 匿名 / 未授权调用投影为 quote-only（白名单 + 精确键断言）。
				const displaySnapshot = isLiveOverlayEnabled(liveOverlayStatus)
					? upstream.snapshot
					: toPublicQuoteSnapshot(upstream.snapshot);
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
								{ ...displaySnapshot, control_plane_status: controlPlaneStatus },
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
		"get_public_quotes",
		{
			description: "获取不含持仓身份的 A/H 公开行情快照。仅返回行情、时间和质量字段。",
			inputSchema: z.object({}),
		},
		async () => {
			const context = bridgeContext("mcp:get_public_quotes");
				try {
					const snapshot = await fetchPublicQuoteSnapshot(context, env);
				return {
					content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
				};
			} catch (error) {
				logBridgeFailure(context, error, "public_quotes");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									error: "UPSTREAM_UNAVAILABLE",
									message: PUBLIC_QUOTES_UNAVAILABLE_MESSAGE,
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

	// C7: these tools deliberately use only the Collector-owned C5 replica.
	// They do not share market/LIVE authorization, and the default research
	// scope is PUBLIC.  PRIVATE remains unavailable until a separate future
	// research-read scope is wired; it never falls through from this surface.
	const researchAdapter = () => {
		const storage = env ? researchReplicaStorage(env) : null;
		if (!storage) throw new ResearchBoundaryError("STORE_UNAVAILABLE");
		return new CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	};
	const researchRead = async (operation: () => Promise<unknown>) => {
		try {
			return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
		} catch (error) {
			const safe =
				error instanceof ResearchBoundaryError
					? error.asError()
					: new ResearchBoundaryError("STORE_UNAVAILABLE").asError();
			return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }] };
		}
	};
	const unsupportedResearchRead = () => ({
		isError: true,
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ status: "UNSUPPORTED", ...new ResearchBoundaryError("UNSUPPORTED_OPERATION").asError() }, null, 2),
			},
		],
	});

	server.registerTool("search_documents", { description: "在 Collector 的 PUBLIC Research replica 中搜索文档元数据。", inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }) }, async ({ query, limit }) => researchRead(() => researchAdapter().searchDocuments(query, limit)));
	server.registerTool("get_document", { description: "读取 Collector replica 中经 SHA-256 校验的 PUBLIC 文档正文。", inputSchema: z.object({ document_id: z.string().min(1) }) }, async ({ document_id }) => researchRead(() => researchAdapter().getDocument(document_id)));
	server.registerTool("search_evidence", { description: "列出 Collector replica 中的 PUBLIC Evidence。", inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) }, async ({ limit }) => researchRead(() => researchAdapter().searchEvidence(limit)));
	server.registerTool("get_evidence", { description: "读取 Collector replica 中指定的 PUBLIC Evidence。", inputSchema: z.object({ evidence_id: z.string().min(1) }) }, async ({ evidence_id }) => researchRead(() => researchAdapter().getEvidence(evidence_id)));
	server.registerTool("get_theme_accumulator", { description: "读取指定主题的 PUBLIC Evidence Accumulator。", inputSchema: z.object({ subject_key: z.string().min(1) }) }, async ({ subject_key }) => researchRead(() => researchAdapter().getThemeAccumulator(subject_key)));
	server.registerTool("get_company_evidence_state", { description: "读取指定公司的 PUBLIC Evidence Accumulator 状态。", inputSchema: z.object({ company: z.string().min(1) }) }, async ({ company }) => researchRead(() => researchAdapter().getCompanyEvidenceState(company)));
	server.registerTool("get_coverage_status", { description: "读取 Collector replica 中的 PUBLIC Research Coverage。", inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) }, async ({ limit }) => researchRead(() => researchAdapter().getCoverageStatus(limit)));
	server.registerTool("get_source_health", { description: "读取 Research source health；当前 replica 未复制该能力时明确返回 UNSUPPORTED。", inputSchema: z.object({}) }, async () => unsupportedResearchRead());
	server.registerTool("list_research_jobs", { description: "列出 Collector replica 中的 PUBLIC QUEUED Research Job。", inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) }, async ({ limit }) => researchRead(() => researchAdapter().listResearchJobs(limit)));
	server.registerTool("get_research_job_context", { description: "读取 Collector replica 中指定 PUBLIC QUEUED Research Job 的上下文。", inputSchema: z.object({ job_id: z.string().min(1) }) }, async ({ job_id }) => researchRead(() => researchAdapter().getResearchJobContext(job_id)));

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

function researchReplicaStorage(env: Env): ResearchReplicaStorage | null {
	return env.RESEARCH_REPLICA && env.RESEARCH_OBJECTS
		? { db: env.RESEARCH_REPLICA, objects: env.RESEARCH_OBJECTS }
		: null;
}

function researchReplicaAuthorized(request: Request, env: Env): boolean {
	const token = env.RESEARCH_REPLICA_INGEST_TOKEN;
	return Boolean(token && request.headers.get("Authorization") === `Bearer ${token}`);
}

function researchBoundaryResponse(error: unknown, status = 400): Response {
	const safe =
		error instanceof ResearchBoundaryError
			? error.asError()
			: new ResearchBoundaryError("STORE_UNAVAILABLE").asError();
	return jsonResponse(safe, status);
}

function decodeBase64Chunks(value: unknown): Uint8Array[] {
	if (!Array.isArray(value)) throw new ResearchBoundaryError("INTEGRITY_FAILED");
	try {
		return value.map((encoded) => {
			if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
				throw new Error("invalid base64");
			}
			const binary = atob(encoded);
			return Uint8Array.from(binary, (character) => character.charCodeAt(0));
		});
	} catch {
		throw new ResearchBoundaryError("INTEGRITY_FAILED");
	}
}

/**
 * C5 private one-way transport.  This is an internal ingestion endpoint, not
 * an MCP tool and not a RESEARCH database connection.  The separate secret is
 * deliberately unrelated to LIVE/market scopes and remains fail-closed until
 * configured.
 */
async function handleResearchReplicaIngest(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return researchBoundaryResponse(new ResearchBoundaryError("UNSUPPORTED_OPERATION"), 405);
	}
	const storage = researchReplicaStorage(env);
	if (!storage || !env.RESEARCH_REPLICA_INGEST_TOKEN) {
		return researchBoundaryResponse(new ResearchBoundaryError("STORE_UNAVAILABLE"), 503);
	}
	if (!researchReplicaAuthorized(request, env)) {
		return researchBoundaryResponse(new ResearchBoundaryError("FILTERED"), 401);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	if (
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body as Record<string, unknown>).some(
			(key) => key !== "record" && key !== "object_chunks_base64",
		)
	) {
		return researchBoundaryResponse(new ResearchBoundaryError("INTEGRITY_FAILED"), 400);
	}
	const transport = body as { record?: unknown; object_chunks_base64?: unknown };
	try {
		const objectChunks =
			transport.object_chunks_base64 === undefined
				? null
				: decodeBase64Chunks(transport.object_chunks_base64);
		return jsonResponse(
			await ingestResearchReplicaRecord(storage, transport.record, objectChunks),
		);
	} catch (error) {
		return researchBoundaryResponse(
			error,
			error instanceof ResearchBoundaryError && error.retryable ? 503 : 400,
		);
	}
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
			return universe
				? jsonResponse(universe)
				: jsonResponse({ error: "NO_LIVE_UNIVERSE" }, 404);
		} catch (error) {
			return jsonResponse(
				{ error: "LIVE_UNIVERSE_READ_FAILED", message: clientFacingErrorMessage(error) },
				500,
			);
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
		return jsonResponse(
			{ error: "INVALID_QUOTE_UNIVERSE", message: clientFacingErrorMessage(error) },
			400,
		);
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
		return jsonResponse(
			{ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) },
			401,
		);
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
		return jsonResponse(
			{ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) },
			401,
		);
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
		return jsonResponse(
			{ error: "INVALID_QUOTE_UNIVERSE", message: clientFacingErrorMessage(error) },
			400,
		);
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
		return jsonResponse(
			{ error: "GITHUB_AUTH_FAILED", message: clientFacingErrorMessage(error) },
			401,
		);
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
		try {
			await recordPortfolioDeltaAfterStatusWrite(env.PORTFOLIO_UNIVERSE, stored);
		} catch (error) {
			// The authenticated status document is already LKG-valid.  Report the
			// private reducer failure explicitly so LIVE retries instead of treating
			// the batch as a fully accepted C3 observation.
			return jsonResponse(
				{
					error: "PORTFOLIO_DELTA_UPDATE_FAILED",
					message: clientFacingErrorMessage(error),
				},
				503,
			);
		}
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
		return jsonResponse(
			{ error: "INVALID_PORTFOLIO_STATUS", message: clientFacingErrorMessage(error) },
			400,
		);
	}
}

/**
 * C3 only observes the authenticated LIVE status push.  A mismatch or an
 * unreadable universe is deliberately downgraded to UNKNOWN for the reducer:
 * it breaks continuity, never manufactures a removal event, and preserves
 * the existing three-state/LRCCA presentation semantics.
 */
async function recordPortfolioDeltaAfterStatusWrite(
	kv: KVNamespace,
	status: StoredPortfolioStatus,
): Promise<void> {
	let universe: StoredLiveUniverse | null = null;
	try {
		universe = await readLiveUniverse(kv);
	} catch {
		// A corrupted private universe cannot participate in COMPLETE→COMPLETE.
		universe = null;
	}
	let state: PortfolioDeltaState = "PORTFOLIO_UNKNOWN";
	if (universe) {
		const freshness = resolveLiveUniverseFreshness(universe, {
			lrcca: status.last_real_complete_confirmed_at,
			now: new Date(),
		});
		// C3 must consume the same conservative state that guards LIVE overlay.
		// A stale LRCCA or hash drift may downgrade a self-declared COMPLETE
		// status, and such a transition must never confirm a removal.
		state = resolvePortfolioPresentation({
			universePresent: true,
			universeContentHash: universe.content_hash,
			universeManifestHash: universe.source_manifest_hash,
			status,
			anchor: {
				anchor: freshness.anchor,
				anchor_fallback: freshness.anchor_fallback,
				fresh: freshness.fresh,
			},
		}).portfolio_state;
	}
	await recordPortfolioUniverseObservation(kv, {
		state,
		current_complete_hash: status.universe_content_hash,
		active_codes: universe?.active ?? [],
		observed_at: status.generated_at,
	});
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
				{
					error: "LIVE_UNIVERSE_STALE",
					portfolio_state: live.presentation.portfolio_state,
				},
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
		return jsonResponse(
			{ error: "PORTFOLIO_QUOTES_UNAVAILABLE", message: clientFacingErrorMessage(error) },
			502,
		);
	}
}

async function handlePublicQuotes(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
	const context = bridgeContext("http:public-quotes");
	try {
		return jsonResponse(await fetchPublicQuoteSnapshot(context, env));
	} catch (error) {
		logBridgeFailure(context, error, "public_quotes");
		return jsonResponse(
			{ error: "UPSTREAM_UNAVAILABLE", message: PUBLIC_QUOTES_UNAVAILABLE_MESSAGE },
			502,
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/api/github-auth/probe") return handleGithubAuthProbe(request);
		if (url.pathname === "/api/github-auth/quote-universe")
			return handleGithubAuthUniverse(request, env);
		if (url.pathname === "/api/github-auth/portfolio-status") {
			return handleGithubAuthPortfolioStatus(request, env);
		}
		if (url.pathname === "/internal/research-replica/v2/ingest") {
			return handleResearchReplicaIngest(request, env);
		}
		if (url.pathname === "/api/control-plane-status" && request.method === "GET") {
			return handleControlPlaneStatus(env);
		}
		if (url.pathname === "/api/quote-universe") return handleUniverseApi(request, env);
		if (url.pathname === "/api/public/quotes") return handlePublicQuotes(request, env);
		if (url.pathname === "/api/portfolio-quotes")
			return handleDynamicPortfolioQuotes(request, env);
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
