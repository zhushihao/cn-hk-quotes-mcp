/**
 * D-1 选项 A（issue #15 / L6）：LIVE 叠加的调用方鉴权门 + 面向调用方的文本去泄漏。
 *
 * 本模块只管两件互相独立的事，且只依赖同仓纯模块 `live-universe.ts`
 * （`node --test` 可直接导入，与本仓 `live-universe.ts` / `portfolio-status.ts`
 * 同纪律）；请求路径与响应构造的接线在 `index.ts`：
 *
 * 1. 鉴权门：LIVE 叠加只有在调用方通过对应请求面的 bearer gate 后才允许应用
 *    （读 KV universe、coverage gate、`holding_status=ACTIVE` 等）。MCP 面由独立的
 *    Collector client credential + `market:read` 决定；内部 universe API 继续由
 *    `PORTFOLIO_UNIVERSE_TOKEN` 决定，两者禁止互相代用。
 *    - 未携带 / 不匹配 → **不报错**，按「无 universe」路径回退既有 legacy 目录视图
 *      （与 `universe_present=false` 时的行为一致），只在
 *      `control_plane_status.live_overlay_status` 标注降级原因；
 *    - 对应 credential 未配置 → 一律 fail-closed（同样走 legacy 路径）；
 *    - 已通过门后：coverage 缺失 → 保持既有 fail-closed 报错；三态未知 / 锚不新鲜
 *      → 保持既有静默回退 legacy（J-11），两者语义均不变。
 *    bearer 精确匹配的底层口径由 `resolveLiveOverlayStatus()` 复用；MCP 再叠加
 *    `market:read` scope gate，内部写入端点不共享外部 client credential。
 *
 * 2. 去泄漏：面向调用方的错误 / 提示文本**不得包含具体证券代码**（coverage 缺失、
 *    identity、stale 等一律去码），缺失**数量**可以保留。
 *    服务端日志不受此限（`index.ts` 的 `logBridgeStage()` 仍可保留明细）。
 *
 * 叠加判定的**唯一实现**在本模块的 `projectCallerSnapshot()`；`index.ts` 只负责
 * 读 KV / 解析三态并把它拼进请求路径——这样「匿名不叠加」这条口径可以被
 * `node --test` 直接驱动真实 fixture 验证，而不是只能靠源码字符串断言。
 */

// 运行期 import 必须带 `.ts` 扩展名：`npm test` 走 `node --experimental-strip-types`，
// 而 Node 的 ESM 解析器不做扩展名补全（本仓既有纯模块之所以能直接测试，是因为它们
// 对其它模块只有 type-only import，运行期被抹掉）。tsconfig 已开
// `allowImportingTsExtensions`，wrangler/esbuild 同样接受显式扩展名。
import {
	applyLiveUniverse,
	getLiveUniverseCoverage,
	type StoredLiveUniverse,
} from "./live-universe.ts";
import type { QuoteSnapshot } from "./portfolio-validation";

/**
 * LIVE 叠加门的三态判定结果。命名即语义，取值同时用于：
 *
 * - `control_plane_status.live_overlay_status`（面向调用方的降级标注）；
 * - `fetchUpstreamSnapshot()` 的 `liveOverlayStatus` 入参（是否应用叠加）；
 * - 结构化日志字段 `live_overlay_status`。
 */
export type LiveOverlayStatus =
	/** 门通过：允许走既有「读 KV + 三态 + coverage」的 LIVE 叠加判定。 */
	| "ENABLED"
	/** 请求未携带 / 未携带匹配的 `Authorization: Bearer <token>` → 降级为 legacy 目录视图。 */
	| "SKIPPED_UNAUTHORIZED"
	/** 服务端未配置对应 credential → 无法鉴权，一律 fail-closed 降级。 */
	| "SKIPPED_TOKEN_NOT_CONFIGURED"
	/** credential 正确，但该 client 未获 `market:read` → fail-closed 降级。 */
	| "SKIPPED_INSUFFICIENT_SCOPE";

/** 全部取值（供测试穷举与文档锁定，避免新增取值时漏改消费侧）。 */
export const LIVE_OVERLAY_STATUSES: readonly LiveOverlayStatus[] = [
	"ENABLED",
	"SKIPPED_UNAUTHORIZED",
	"SKIPPED_TOKEN_NOT_CONFIGURED",
	"SKIPPED_INSUFFICIENT_SCOPE",
];

/** ChatGPT / Automation 读取 LIVE market overlay 的最小批准 scope。 */
export const MARKET_READ_SCOPE = "market:read";

/**
 * 鉴权门判定（与既有 `isUniverseAuthorized()` 同口径）：
 *
 * - 服务端未配置 token → `SKIPPED_TOKEN_NOT_CONFIGURED`（fail-closed，不看请求头）；
 * - 请求头**逐字节**等于 `Bearer <configured>` → `ENABLED`；大小写、空格、额外字段
 *   一律判不匹配（沿用既有实现，不做宽松化）；
 * - 其余（含缺头、空 token、其他任意凭据）→ `SKIPPED_UNAUTHORIZED`。
 *
 * 本函数只做判定，不返回、不记录、不回显任何 token 值。
 */
export function resolveLiveOverlayStatus(
	authorizationHeader: string | null | undefined,
	configuredToken: string | null | undefined,
): LiveOverlayStatus {
	if (!configuredToken) return "SKIPPED_TOKEN_NOT_CONFIGURED";
	return authorizationHeader === `Bearer ${configuredToken}` ? "ENABLED" : "SKIPPED_UNAUTHORIZED";
}

/**
 * QuantPro Collector MCP 外部 client 的 LIVE market read 门。
 *
 * 与 `PORTFOLIO_UNIVERSE_TOKEN` **刻意解耦**：调用方传入的是独立的
 * Collector MCP client credential；credential 通过后还必须显式具备
 * `market:read`。token 值不会被返回、记录或写入任何 tool schema。
 */
export function resolveMarketReadLiveOverlayStatus(
	authorizationHeader: string | null | undefined,
	configuredClientToken: string | null | undefined,
	configuredScopes: string | null | undefined,
): LiveOverlayStatus {
	const credentialStatus = resolveLiveOverlayStatus(authorizationHeader, configuredClientToken);
	if (credentialStatus !== "ENABLED") return credentialStatus;

	const scopes = new Set(
		(configuredScopes ?? "")
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean),
	);
	return scopes.has(MARKET_READ_SCOPE) ? "ENABLED" : "SKIPPED_INSUFFICIENT_SCOPE";
}

/** 门是否放行（唯一判据：`=== "ENABLED"`；其余取值一律不放行，fail-closed）。 */
export function isLiveOverlayEnabled(status: LiveOverlayStatus): boolean {
	return status === "ENABLED";
}

/**
 * coverage 缺失的**面向调用方**文本：只出数量，绝不出代码。
 *
 * 旧文本形如 `upstream quote catalog is missing LIVE positions: CN:002409, CN:002975`
 * —— 即使不修覆盖门，匿名调用也会经错误路径泄漏真实在仓代码（issue #15 §8.3）。
 * 逐代码明细改走服务端结构化日志（`index.ts` 的
 * `live_universe_coverage_incomplete` 事件），不出现在任何调用方响应里。
 */
export function formatLiveCoverageFailureMessage(missingCount: number): string {
	return `upstream quote catalog is missing ${missingCount} LIVE positions`;
}

/** 面向调用方文本中的证券代码占位符。 */
export const INSTRUMENT_CODE_PLACEHOLDER = "[REDACTED_CODE]";

/**
 * 证券代码形态：`CN:002409` / `HK:09696` / `SZ:300308`（`instrumentKey` 形态），
 * 以及裸代码（A 股 6 位 / 港股 5 位）。
 *
 * 边界（避免误伤）：
 * - 前后不得紧邻字母 / 数字 / 下划线，故 `sha256:<hex>` 与 `live:<hash>` 内部的
 *   数字串不会被切断；
 * - 裸代码分支额外排除「紧跟在 `:` 之后」的位置（`(?<![0-9A-Za-z_:])`），
 *   故 `sha256:123456…`、`content_hash: …` 之类哈希不透明串不会被改写；
 * - `age=864000s` 这类以字母收尾的数字串也不会命中（`\b` 等价的后置断言不成立）。
 */
const INSTRUMENT_CODE_PATTERN =
	/(?<![0-9A-Za-z_:])[A-Za-z]{2}:[0-9]{5,6}(?![0-9A-Za-z])|(?<![0-9A-Za-z_:])[0-9]{5,6}(?![0-9A-Za-z])/g;

/**
 * 去码：把文本中的证券代码形态替换为 `[REDACTED_CODE]`。
 *
 * 幂等（占位符本身不含代码形态，重复调用结果不变）；空串 / 无命中原样返回。
 */
export function redactInstrumentCodes(text: string): string {
	if (!text) return text;
	return text.replace(INSTRUMENT_CODE_PATTERN, INSTRUMENT_CODE_PLACEHOLDER);
}

/**
 * coverage 缺失的 fail-closed 异常（已带数量文本）。
 *
 * `message` 即面向调用方的文本（`formatLiveCoverageFailureMessage()`，只含数量）；
 * `missingActive` 仅供 `index.ts` 写服务端结构化日志，**不得**进入任何响应体。
 */
export class LiveCoverageError extends Error {
	readonly missingActive: readonly string[];
	readonly missingCount: number;
	readonly activeCount: number;
	readonly quotedActiveCount: number;

	constructor(coverage: {
		active_count: number;
		quoted_active_count: number;
		missing_active: readonly string[];
	}) {
		super(formatLiveCoverageFailureMessage(coverage.missing_active.length));
		this.name = "LiveCoverageError";
		this.missingActive = coverage.missing_active;
		this.missingCount = coverage.missing_active.length;
		this.activeCount = coverage.active_count;
		this.quotedActiveCount = coverage.quoted_active_count;
	}
}

/**
 * `coverage` 字段的取值面：沿用既有日志口径（`NOT_CONFIGURED` / `COMPLETE` / `INCOMPLETE`
 * / `SKIPPED_PORTFOLIO_NOT_CONFIRMED`），外加门未放行时的三态词。
 * （`INCOMPLETE` 会先抛 `LiveCoverageError`，故实际不会作为返回值出现。）
 */
export type LiveOverlayCoverage =
	| "NOT_CONFIGURED"
	| "COMPLETE"
	| "INCOMPLETE"
	| "SKIPPED_PORTFOLIO_NOT_CONFIRMED"
	| LiveOverlayStatus;

export type LiveOverlayOutcome = {
	/** 调用方最终拿到的快照；未叠加时逐字段等于入参（不做任何就地修改）。 */
	snapshot: QuoteSnapshot;
	/** 是否**实际**应用了 LIVE 叠加（门放行但三态未确认时仍为 false）。 */
	applied: boolean;
	/** 日志 / 诊断口径：`NOT_CONFIGURED` / `COMPLETE` / `SKIPPED_*`。 */
	coverage: LiveOverlayCoverage;
};

export type CallerProjectionInput = {
	snapshot: QuoteSnapshot;
	/** 门判定结果（见 `resolveLiveOverlayStatus()`）。 */
	liveOverlayStatus: LiveOverlayStatus;
	/** KV binding 是否存在（即 `env.PORTFOLIO_UNIVERSE` 是否绑定）。 */
	universeBound: boolean;
	/** KV 读出的 LKG 投影；未读（门未放行）/ 无件 / 不可读按 `null`。 */
	universe?: StoredLiveUniverse | null;
	/** 三态呈现口径的 `apply_overlay`（`resolvePortfolioPresentation()` 的输出）。 */
	applyOverlay?: boolean;
};

/**
 * D-1 选项 A 的**唯一叠加出口**（纯函数，无 IO）：
 *
 * 1. KV 未绑定 → 原样返回（`NOT_CONFIGURED`，与迁移前一致）；
 * 2. 门未放行（未带 / 错带 token，或服务端未配置 token）→ 原样返回 legacy 目录视图，
 *    **不报错**，`coverage` 记门的三态词（降级原因随
 *    `control_plane_status.live_overlay_status` 一并外发）；
 * 3. 门放行但无 universe → 原样返回（`NOT_CONFIGURED`，与既有 `universe_present=false` 同口径）；
 * 4. 门放行但三态未确认（`PORTFOLIO_UNKNOWN`）→ 原样返回（`SKIPPED_PORTFOLIO_NOT_CONFIRMED`，J-11）；
 * 5. 门放行且三态确认 → coverage gate：不完整即抛 `LiveCoverageError`（fail-closed，
 *    文本只含数量）；完整则应用叠加。
 *
 * 除第 5 条外，本函数在任何分支都不会因门未放行而报错。
 */
export function projectCallerSnapshot(input: CallerProjectionInput): LiveOverlayOutcome {
	if (!input.universeBound) {
		return { snapshot: input.snapshot, applied: false, coverage: "NOT_CONFIGURED" };
	}
	if (!isLiveOverlayEnabled(input.liveOverlayStatus)) {
		return { snapshot: input.snapshot, applied: false, coverage: input.liveOverlayStatus };
	}
	const universe = input.universe ?? null;
	if (!universe) {
		return { snapshot: input.snapshot, applied: false, coverage: "NOT_CONFIGURED" };
	}
	if (!input.applyOverlay) {
		return {
			snapshot: input.snapshot,
			applied: false,
			coverage: "SKIPPED_PORTFOLIO_NOT_CONFIRMED",
		};
	}
	const coverage = getLiveUniverseCoverage(input.snapshot, universe);
	if (coverage.status !== "COMPLETE") {
		throw new LiveCoverageError(coverage);
	}
	return {
		snapshot: applyLiveUniverse(input.snapshot, universe),
		applied: true,
		coverage: coverage.status,
	};
}
