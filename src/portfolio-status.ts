/**
 * portfolio-status/1 —— LIVE「真实完整确认」状态件（issue #15 / B2，规格 §5.3）。
 *
 * 事实源在 LIVE：状态件由 LIVE 侧（`quantpro-qmt/pipeline/portfolio/status_doc.py`）
 * 构造并经鉴权端点推送。本模块是 Worker 侧唯一的校验 / 复核 / 消费口径实现：
 *
 * - 顶层**精确六键**（多键少键皆拒），禁键与 `quote-universe/1` 投影同纪律；
 * - `state` 恰三值；两个 hash 为 `sha256:<64 lowercase hex>`；
 * - `last_real_complete_confirmed_at`（LRCCA）是 LIVE build 状态 `last_success_at`
 *   的对外命名（规格 §5.1 别名裁定），语义 = 最近一次真实完整柜台确认；
 * - 三态阈值（规格 §5.2）：≤24h → LIVE_COMPLETE；≤10×86400s（含恰等）→ LKG_VALID；
 *   超期或无基线 → PORTFOLIO_UNKNOWN；`active=[]` 的完整确认 ≠ 未知；
 * - J-4：Worker 用状态件携带的 LRCCA 按同一规则复核，与自述态不一致时取更保守态；
 * - J-11 / C-5：PORTFOLIO_UNKNOWN 不应用 LIVE overlay（未知不得伪称当前持仓）。
 *
 * 本模块**不** import `live-universe.ts`（锚解析在那里单独实现，由 `index.ts` 组装），
 * 以保持两侧模块无环；同时保持零运行时依赖，使 `node --test` 可直接导入。
 */

export const PORTFOLIO_STATUS_SCHEMA = "portfolio-status/1" as const;
/** KV key 与 `live-portfolio/current` 平级（规格 §3.3 I-1 / §5.3）。 */
export const PORTFOLIO_STATUS_KV_KEY = "live-portfolio/status";

/** 规格 §5.2：阈值 24h，吸收正常隔夜（窗口 09:00–16:10，最后一次确认到次日开盘约 17h）。 */
export const LIVE_COMPLETE_MAX_AGE_SECONDS = 24 * 60 * 60;
/** 规格 §5.2：10 自然日（含第 10 天）内可继续以 LKG 供数。 */
export const LKG_VALID_MAX_AGE_SECONDS = 10 * 24 * 60 * 60;
/** 与 `live-universe.ts` 同口径：超过该秒数的「未来」时间不可信，按 fail-closed 处理。 */
const FUTURE_TOLERANCE_SECONDS = 300;
/** 与既有 universe 端点同款的请求体上限。 */
export const PORTFOLIO_STATUS_MAX_PAYLOAD_BYTES = 32_768;

export type PortfolioState = "LIVE_COMPLETE" | "LKG_VALID" | "PORTFOLIO_UNKNOWN";

export type PortfolioStatusPayload = {
	schema_version: typeof PORTFOLIO_STATUS_SCHEMA;
	generated_at: string;
	state: PortfolioState;
	last_real_complete_confirmed_at: string | null;
	universe_content_hash: string;
	source_manifest_hash: string;
};

export type StoredPortfolioStatus = PortfolioStatusPayload & {
	/** 与 `StoredLiveUniverse` 同款：写入时注入、读出时剥离后重新全量校验。 */
	received_at: string;
};

const TOP_LEVEL_KEYS = new Set([
	"schema_version",
	"generated_at",
	"state",
	"last_real_complete_confirmed_at",
	"universe_content_hash",
	"source_manifest_hash",
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PORTFOLIO_STATES: PortfolioState[] = ["LIVE_COMPLETE", "LKG_VALID", "PORTFOLIO_UNKNOWN"];
const PORTFOLIO_STATE_SET = new Set<string>(PORTFOLIO_STATES);
/** 保守序：数值越大越保守（J-4 复核不一致时取更大者）。 */
const CONSERVATISM: Record<PortfolioState, number> = {
	LIVE_COMPLETE: 0,
	LKG_VALID: 1,
	PORTFOLIO_UNKNOWN: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 平移 `live-universe.ts` 的精确键范式；此处同时拒绝缺失键（多一少一皆拒）。 */
function assertExactKeys(
	record: Record<string, unknown>,
	allowed: Set<string>,
	context: string,
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`${context}.${key} is not allowed`);
	}
	for (const key of allowed) {
		if (!(key in record)) throw new Error(`${context}.${key} is required`);
	}
}

function assertTimestamp(value: unknown, context: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${context} must be a non-empty string`);
	}
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`${context} must be a parseable timestamp`);
	}
	return value;
}

export function validatePortfolioStatus(value: unknown): PortfolioStatusPayload {
	if (!isRecord(value)) throw new Error("portfolio status must be an object");
	assertExactKeys(value, TOP_LEVEL_KEYS, "portfolio_status");
	if (value.schema_version !== PORTFOLIO_STATUS_SCHEMA) {
		throw new Error(`schema_version must be ${PORTFOLIO_STATUS_SCHEMA}`);
	}
	const generatedAt = assertTimestamp(value.generated_at, "generated_at");
	const declared = value.state;
	if (typeof declared !== "string" || !PORTFOLIO_STATE_SET.has(declared)) {
		throw new Error(`state must be one of ${PORTFOLIO_STATES.join(", ")}`);
	}
	let confirmedAt: string | null = null;
	if (value.last_real_complete_confirmed_at !== null) {
		confirmedAt = assertTimestamp(
			value.last_real_complete_confirmed_at,
			"last_real_complete_confirmed_at",
		);
	}
	for (const field of ["universe_content_hash", "source_manifest_hash"] as const) {
		const candidate = value[field];
		if (typeof candidate !== "string" || !HASH_PATTERN.test(candidate)) {
			throw new Error(`${field} must be sha256:<64 lowercase hex>`);
		}
	}
	// 规格 §5.2 推导不变式：没有 LRCCA 就不可能有 LIVE_COMPLETE / LKG_VALID 基线。
	if (declared !== "PORTFOLIO_UNKNOWN" && confirmedAt === null) {
		throw new Error(`state ${declared} requires last_real_complete_confirmed_at`);
	}
	return {
		schema_version: PORTFOLIO_STATUS_SCHEMA,
		generated_at: generatedAt,
		state: declared as PortfolioState,
		last_real_complete_confirmed_at: confirmedAt,
		universe_content_hash: value.universe_content_hash as string,
		source_manifest_hash: value.source_manifest_hash as string,
	};
}

export async function writePortfolioStatus(
	kv: KVNamespace,
	value: unknown,
	receivedAt = new Date().toISOString(),
): Promise<StoredPortfolioStatus> {
	// 先全量校验再 put：非法件拒写、旧件保留（沿用 writeLiveUniverse 的 LKG 语义）。
	const validated = validatePortfolioStatus(value);
	const stored: StoredPortfolioStatus = { ...validated, received_at: receivedAt };
	await kv.put(PORTFOLIO_STATUS_KV_KEY, JSON.stringify(stored));
	return stored;
}

export async function readPortfolioStatus(kv: KVNamespace): Promise<StoredPortfolioStatus | null> {
	const raw = await kv.get(PORTFOLIO_STATUS_KV_KEY);
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("stored portfolio status is invalid JSON");
	}
	if (!isRecord(parsed) || typeof parsed.received_at !== "string" || !parsed.received_at) {
		throw new Error("stored portfolio status is missing received_at");
	}
	const receivedAt = parsed.received_at;
	const payload = { ...parsed };
	delete payload.received_at;
	const validated = validatePortfolioStatus(payload);
	return { ...validated, received_at: receivedAt };
}

export type PortfolioStateDerivation = {
	lastRealCompleteConfirmedAt: string | null;
	/** LKG（= KV 中的 `quote-universe/1` 投影）是否可用；无基线直接 PORTFOLIO_UNKNOWN。 */
	lkgPresent: boolean;
	now?: Date;
};

/**
 * 规格 §5.2 纯函数：由 LRCCA + LKG 存在性 + 当前时刻推导三态。
 * 边界钉死：`age == 24h` 仍 LIVE_COMPLETE；`age == 10×86400s` 仍 LKG_VALID；
 * 超 1 秒即翻 PORTFOLIO_UNKNOWN；不可信的未来时间同样 fail-closed 到 UNKNOWN。
 */
export function derivePortfolioState(input: PortfolioStateDerivation): PortfolioState {
	if (!input.lkgPresent) return "PORTFOLIO_UNKNOWN";
	const confirmedAt = input.lastRealCompleteConfirmedAt;
	if (!confirmedAt) return "PORTFOLIO_UNKNOWN";
	const parsed = Date.parse(confirmedAt);
	if (!Number.isFinite(parsed)) return "PORTFOLIO_UNKNOWN";
	const now = input.now ?? new Date();
	const ageSeconds = (now.getTime() - parsed) / 1000;
	if (ageSeconds < -FUTURE_TOLERANCE_SECONDS) return "PORTFOLIO_UNKNOWN";
	if (ageSeconds <= LIVE_COMPLETE_MAX_AGE_SECONDS) return "LIVE_COMPLETE";
	if (ageSeconds <= LKG_VALID_MAX_AGE_SECONDS) return "LKG_VALID";
	return "PORTFOLIO_UNKNOWN";
}

/** 取更保守态（保守序：PORTFOLIO_UNKNOWN > LKG_VALID > LIVE_COMPLETE）。 */
export function mostConservativePortfolioState(...states: PortfolioState[]): PortfolioState {
	if (states.length === 0) return "PORTFOLIO_UNKNOWN";
	let result: PortfolioState = states[0];
	for (const state of states) {
		if (CONSERVATISM[state] > CONSERVATISM[result]) result = state;
	}
	return result;
}

/** J-4：Worker 复核结果与状态件自述态不一致时取更保守者。 */
export function reconcilePortfolioState(
	declared: PortfolioState,
	recomputed: PortfolioState,
): PortfolioState {
	return mostConservativePortfolioState(declared, recomputed);
}

/** J-13：KV 无多键事务，交叉核对不一致时按瞬时态保守呈现（最高只到 LKG_VALID），不判故障。 */
export function downgradePortfolioState(
	state: PortfolioState,
	floor: PortfolioState = "LKG_VALID",
): PortfolioState {
	return mostConservativePortfolioState(state, floor);
}

export function isOverlayAllowed(state: PortfolioState): boolean {
	return state !== "PORTFOLIO_UNKNOWN";
}

/** `live-universe.resolveLiveUniverseFreshness()` 的输出投影（避免跨模块类型耦合）。 */
export type PortfolioAnchorView = {
	anchor: "LRCCA" | "GENERATED_AT";
	anchor_fallback: boolean;
	fresh: boolean;
};

export type PortfolioPresentationInput = {
	universePresent: boolean;
	universeContentHash: string | null;
	universeManifestHash: string | null;
	/** null = 状态件缺失或不可读（损坏 / 非法）→ 按「无件」口径保守呈现。 */
	status: PortfolioStatusPayload | null;
	/** 新鲜度锚解析结果；无 universe 时为 null。 */
	anchor: PortfolioAnchorView | null;
	now?: Date;
};

/**
 * 消费侧呈现口径（C-3 / C-4 / C-5 的单一出口）：
 * - `portfolio_state`：状态件自述态经 J-4 复核 + J-13 交叉核对后的**保守**三态；
 * - `stale`：非 LIVE_COMPLETE 即为 true（LKG_VALID / UNKNOWN 期间供数必须带标记）；
 * - `apply_overlay`：仅 LIVE_COMPLETE / LKG_VALID 且锚新鲜时应用 LIVE overlay；
 *   PORTFOLIO_UNKNOWN（含无状态件）一律不应用（J-11，回退静态目录，不报错）；
 * - `freshness_anchor` / `freshness_anchor_fallback`：双轨锚（LRCCA 优先，
 *   generated_at 兜底过渡）的留痕，供 `control-plane-status` 与运维判读。
 */
export type PortfolioPresentation = {
	portfolio_state: PortfolioState;
	/** 状态件自述态（诊断用，不进公开面）。 */
	declared_state: PortfolioState | null;
	state_source: "STATUS_DOC" | "STATUS_DOC_MISSING";
	state_reconciled: boolean;
	stale: boolean;
	apply_overlay: boolean;
	fresh: boolean;
	freshness_anchor: "LRCCA" | "GENERATED_AT" | null;
	freshness_anchor_fallback: boolean;
	/** 状态件与 universe 的 hash 交叉核对是否不一致（诊断用，不进公开面）。 */
	cross_check_mismatch: boolean;
};

export function resolvePortfolioPresentation(
	input: PortfolioPresentationInput,
): PortfolioPresentation {
	const now = input.now ?? new Date();
	const fresh = input.universePresent && input.anchor !== null && input.anchor.fresh;
	const freshnessAnchor = input.anchor?.anchor ?? null;
	const freshnessAnchorFallback = input.anchor?.anchor_fallback ?? false;

	if (!input.status) {
		// C-3：无件（或损坏 → 按无件）→ UNKNOWN 口径。
		// J-11 / C-5：UNKNOWN 不应用 LIVE overlay，不把旧投影当「当前持仓」。
		return {
			portfolio_state: "PORTFOLIO_UNKNOWN",
			declared_state: null,
			state_source: "STATUS_DOC_MISSING",
			state_reconciled: false,
			stale: true,
			apply_overlay: false,
			fresh,
			freshness_anchor: freshnessAnchor,
			freshness_anchor_fallback: freshnessAnchorFallback,
			cross_check_mismatch: false,
		};
	}

	const declared = input.status.state;
	// J-4：用状态件携带的 LRCCA 按同一规则复算（lkgPresent = KV 投影可用），取更保守态。
	const recomputed = derivePortfolioState({
		lastRealCompleteConfirmedAt: input.status.last_real_complete_confirmed_at,
		lkgPresent: input.universePresent,
		now,
	});
	let state = reconcilePortfolioState(declared, recomputed);
	const crossCheckMismatch =
		!input.universePresent ||
		input.universeContentHash !== input.status.universe_content_hash ||
		input.universeManifestHash !== input.status.source_manifest_hash;
	if (crossCheckMismatch) state = downgradePortfolioState(state);

	return {
		portfolio_state: state,
		declared_state: declared,
		state_source: "STATUS_DOC",
		state_reconciled: state !== declared,
		stale: state !== "LIVE_COMPLETE",
		apply_overlay: fresh && isOverlayAllowed(state),
		fresh,
		freshness_anchor: freshnessAnchor,
		freshness_anchor_fallback: freshnessAnchorFallback,
		cross_check_mismatch: crossCheckMismatch,
	};
}
