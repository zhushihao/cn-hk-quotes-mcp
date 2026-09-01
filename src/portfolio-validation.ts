export const EXPECTED_PORTFOLIO_VERSION = "2026-09-01-v4";

export type QuoteGroup = "Core" | "Growth" | "Watch";
/** Lower-case technical buckets. Mapping is a quote row type, not a status. */
export type PortfolioGroup = "core" | "growth" | "watch" | "mapping";
export type PortfolioStatus = "CORE" | "GROWTH" | "WATCH" | null;
export type HoldingStatus = "ACTIVE" | "MAPPING_ONLY" | "WATCH";

export type QuoteStock = {
	code: string;
	market: "CN" | "HK";
	exchange: "SZ" | "SH" | "HK";
	name: string;
	group: QuoteGroup;
	portfolio_group: PortfolioGroup;
	portfolio_status: PortfolioStatus;
	holding_status: HoldingStatus;
	mapping_only: boolean;
	mapped_to: string | null;
	/** Legacy alias retained in the snapshot contract. */
	mapping_to: string | null;
	position_qty: number | null;
	is_position: boolean;
	[key: string]: unknown;
};

export type PortfolioUniverseItem = Pick<
	QuoteStock,
	| "code"
	| "market"
	| "exchange"
	| "name"
	| "group"
	| "portfolio_group"
	| "portfolio_status"
	| "holding_status"
	| "mapping_only"
	| "mapped_to"
	| "mapping_to"
	| "position_qty"
	| "is_position"
>;

export type QuoteSummary = {
	total: number;
	[key: string]: unknown;
};

export type QuoteSnapshot = {
	portfolio_version: string;
	snapshot_time: string;
	system_quality: string;
	summary: QuoteSummary;
	portfolio_universe: PortfolioUniverseItem[];
	stocks: QuoteStock[];
	[key: string]: unknown;
};

export type SnapshotCounts = {
	total: number;
	activeQuoteTotal: number;
	activeHoldingTotal: number;
	watchTotal: number;
	exitedWatchTotal: number;
	coreTotal: number;
	growthTotal: number;
	mappingTotal: number;
};

export type SnapshotValidationOptions = {
	expectedActiveQuoteTotal?: number;
	requireWatch?: boolean;
};

/**
 * This is a validation contract, not a second editable portfolio config.
 * The Site's PORTFOLIO_UNIVERSE is the runtime source of truth; these keys
 * prevent an old or partially updated Site from being accepted by the bridge.
 */
export const EXPECTED_MARKET_CODE_KEYS = [
	"CN:300308",
	"HK:03308",
	"CN:300502",
	"CN:300394",
	"CN:688676",
	"CN:601872",
	"CN:588080",
	"HK:09696",
	"CN:002466",
	"CN:002192",
	"CN:300433",
	"CN:588170",
	"CN:603308",
	"CN:600096",
	"CN:605376",
	"CN:301183",
	"CN:688596",
	"HK:09988",
	"HK:02228",
	"CN:603893",
	"CN:002460",
	"CN:002240",
	"CN:002738",
] as const;

export const EXPECTED_ACTIVE_QUOTE_KEYS = [
	"CN:300308",
	"HK:03308",
	"CN:300502",
	"CN:300394",
	"CN:688676",
	"CN:601872",
	"CN:588080",
	"HK:09696",
	"CN:002466",
	"CN:002192",
	"CN:300433",
	"CN:588170",
	"CN:603308",
] as const;

export const REQUIRED_WATCH_KEYS = [
	"CN:600096",
	"CN:605376",
	"CN:301183",
	"CN:688596",
	"HK:09988",
	"HK:02228",
	"CN:603893",
	"CN:002460",
	"CN:002240",
	"CN:002738",
] as const;

export const REQUIRED_MAPPING_KEYS = ["HK:03308", "CN:002466"] as const;

const GROUPS = new Set<QuoteGroup>(["Core", "Growth", "Watch"]);
const PORTFOLIO_GROUPS = new Set<PortfolioGroup>(["core", "growth", "watch", "mapping"]);
const PORTFOLIO_STATUSES = new Set<Exclude<PortfolioStatus, null>>(["CORE", "GROWTH", "WATCH"]);
const HOLDING_STATUSES = new Set<HoldingStatus>(["ACTIVE", "MAPPING_ONLY", "WATCH"]);
const MARKETS = new Set(["CN", "HK"]);
const EXCHANGES = new Set(["SZ", "SH", "HK"]);

const REQUIRED_STOCK_FIELDS = [
	"code",
	"market",
	"exchange",
	"name",
	"group",
	"portfolio_group",
	"portfolio_status",
	"holding_status",
	"mapping_only",
	"mapped_to",
	"mapping_to",
	"position_qty",
	"is_position",
	"price",
	"change",
	"change_pct",
	"pre_close",
	"prev_close",
	"open",
	"high",
	"low",
	"pct_change",
	"volume",
	"amount",
	"market_status",
	"market_data_time",
	"source_update_time",
	"freshness_basis",
	"quote_time",
	"fetch_time",
	"age_seconds",
	"primary_source",
	"secondary_source",
	"source_status",
	"quality",
] as const;

const DERIVED_SUMMARY_FIELDS = [
	"active_quote_total",
	"active_holding_total",
	"watch_total",
	"exited_watch_total",
	"mapping_total",
	"core_total",
	"growth_total",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function requireString(record: Record<string, unknown>, field: string, context: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${context}.${field} must be a non-empty string`);
	}
	return value;
}

function instrumentKey(stock: Pick<QuoteStock, "market" | "code">): string {
	return `${stock.market}:${stock.code}`;
}

function validateClassification(
	stock: Record<string, unknown>,
	context: string,
): asserts stock is Record<string, unknown> & QuoteStock {
	const market = stock.market;
	const exchange = stock.exchange;
	const group = stock.group;
	const portfolioGroup = stock.portfolio_group;
	const portfolioStatus = stock.portfolio_status;
	const holdingStatus = stock.holding_status;
	if (typeof market !== "string" || !MARKETS.has(market)) {
		throw new Error(`${context}.market must be CN or HK`);
	}
	if (typeof exchange !== "string" || !EXCHANGES.has(exchange)) {
		throw new Error(`${context}.exchange must be SZ, SH, or HK`);
	}
	if ((market === "HK" && exchange !== "HK") || (market === "CN" && exchange === "HK")) {
		throw new Error(`${context}.market and exchange are inconsistent`);
	}
	if (typeof group !== "string" || !GROUPS.has(group as QuoteGroup)) {
		throw new Error(`${context}.group must be Core, Growth, or Watch`);
	}
	if (typeof portfolioGroup !== "string" || !PORTFOLIO_GROUPS.has(portfolioGroup as PortfolioGroup)) {
		throw new Error(`${context}.portfolio_group is invalid`);
	}
	if (portfolioStatus !== null && (typeof portfolioStatus !== "string" || !PORTFOLIO_STATUSES.has(portfolioStatus as Exclude<PortfolioStatus, null>))) {
		throw new Error(`${context}.portfolio_status must be CORE, GROWTH, WATCH, or null`);
	}
	if (typeof holdingStatus !== "string" || !HOLDING_STATUSES.has(holdingStatus as HoldingStatus)) {
		throw new Error(`${context}.holding_status is invalid`);
	}
	if (typeof stock.mapping_only !== "boolean") {
		throw new Error(`${context}.mapping_only must be boolean`);
	}

	const normalizedGroup = group as QuoteGroup;
	const normalizedPortfolioGroup = portfolioGroup as PortfolioGroup;
	const normalizedStatus = holdingStatus as HoldingStatus;
	const expectedBroadGroup: QuoteGroup =
		normalizedPortfolioGroup === "core" || normalizedPortfolioGroup === "mapping"
			? "Core"
			: normalizedPortfolioGroup === "growth"
				? "Growth"
				: "Watch";
	if (normalizedGroup !== expectedBroadGroup) {
		throw new Error(`${context}.group does not match portfolio_group`);
	}

	const expectedStatus: HoldingStatus =
		normalizedPortfolioGroup === "mapping"
			? "MAPPING_ONLY"
			: normalizedPortfolioGroup === "watch"
				? "WATCH"
				: "ACTIVE";
	if (normalizedStatus !== expectedStatus) {
		throw new Error(`${context}.holding_status does not match portfolio_group`);
	}
	const expectedPortfolioStatus: PortfolioStatus =
		normalizedPortfolioGroup === "core"
			? "CORE"
			: normalizedPortfolioGroup === "growth"
				? "GROWTH"
				: normalizedPortfolioGroup === "watch"
					? "WATCH"
					: null;
	if (portfolioStatus !== expectedPortfolioStatus) {
		throw new Error(`${context}.portfolio_status does not match portfolio_group`);
	}
	const expectedMappingOnly = normalizedPortfolioGroup === "mapping";
	if (stock.mapping_only !== expectedMappingOnly) {
		throw new Error(`${context}.mapping_only does not match portfolio_group`);
	}

	const mappingTo = stock.mapping_to;
	const mappedTo = stock.mapped_to;
	for (const [field, value] of [["mapping_to", mappingTo], ["mapped_to", mappedTo]] as const) {
		if (value !== null && typeof value !== "string") {
			throw new Error(`${context}.${field} must be a string or null`);
		}
	}
	if (mappingTo !== mappedTo) {
		throw new Error(`${context}.mapping_to and mapped_to must match`);
	}
	if (normalizedPortfolioGroup === "mapping") {
		if (typeof mappingTo !== "string" || !mappingTo) {
			throw new Error(`${context}.mapping records require a non-empty mapping_to`);
		}
	} else if (mappingTo !== null || mappedTo !== null) {
		throw new Error(`${context}.mapping fields are only allowed for mapping records`);
	}

	const positionQty = stock.position_qty;
	if (positionQty !== null && (!isFiniteNumber(positionQty) || positionQty < 0)) {
		throw new Error(`${context}.position_qty must be null or a non-negative number`);
	}
	const isPosition = stock.is_position;
	if (typeof isPosition !== "boolean") {
		throw new Error(`${context}.is_position must be boolean`);
	}
	if (isPosition !== (normalizedPortfolioGroup === "core" || normalizedPortfolioGroup === "growth")) {
		throw new Error(`${context}.position_qty and is_position are inconsistent`);
	}
	if (!isPosition && positionQty !== 0) {
		throw new Error(`${context}.non-position rows must have position_qty=0`);
	}
	if (isPosition && positionQty !== null && positionQty <= 0) {
		throw new Error(`${context}.position_qty must be positive when supplied for a position`);
	}
}

function validateStock(value: unknown, index: number): QuoteStock {
	const context = `stocks[${index}]`;
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	for (const field of REQUIRED_STOCK_FIELDS) {
		if (!(field in value)) throw new Error(`${context}.${field} is required`);
	}
	requireString(value, "code", context);
	requireString(value, "name", context);
	validateClassification(value, context);

	const numericFields = [
		"price",
		"change",
		"change_pct",
		"pre_close",
		"prev_close",
		"open",
		"high",
		"low",
		"pct_change",
		"volume",
		"amount",
		"age_seconds",
	] as const;
	for (const field of numericFields) {
		const fieldValue = value[field];
		const nullableNonPositionField = !value.is_position && fieldValue === null;
		if (!isFiniteNumber(fieldValue) && !nullableNonPositionField) {
			throw new Error(`${context}.${field} must be a finite number`);
		}
	}
	for (const field of ["market_status", "freshness_basis", "source_status", "quality"] as const) {
		requireString(value, field, context);
	}
	if (value.market_status !== "OPEN" && value.market_status !== "CLOSED") {
		throw new Error(`${context}.market_status must be OPEN or CLOSED`);
	}
	for (const field of ["market_data_time", "quote_time", "source_update_time"] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue !== "string" && fieldValue !== null) {
			throw new Error(`${context}.${field} must be a string or null`);
		}
	}
	requireString(value, "fetch_time", context);
	for (const field of ["primary_source", "secondary_source"] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue !== "string" && fieldValue !== null) {
			throw new Error(`${context}.${field} must be a string or null`);
		}
	}
	return value as QuoteStock;
}

function validateUniverseItem(value: unknown, index: number): PortfolioUniverseItem {
	const context = `portfolio_universe[${index}]`;
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	for (const field of [
		"code",
		"market",
		"exchange",
		"name",
		"group",
		"portfolio_group",
		"portfolio_status",
		"holding_status",
		"mapping_only",
		"mapped_to",
		"mapping_to",
		"position_qty",
		"is_position",
	] as const) {
		if (!(field in value)) throw new Error(`${context}.${field} is required`);
	}
	requireString(value, "code", context);
	requireString(value, "name", context);
	validateClassification(value, context);
	return value as PortfolioUniverseItem;
}

export function getSnapshotCounts(snapshot: QuoteSnapshot): SnapshotCounts {
	let activeQuoteTotal = 0;
	let activeHoldingTotal = 0;
	let watchTotal = 0;
	let coreTotal = 0;
	let growthTotal = 0;
	let mappingTotal = 0;

	for (const stock of snapshot.stocks) {
		if (stock.portfolio_group === "core") coreTotal += 1;
		if (stock.portfolio_group === "growth") growthTotal += 1;
		if (stock.portfolio_group === "watch") watchTotal += 1;
		if (stock.portfolio_group === "mapping") mappingTotal += 1;
		if (stock.portfolio_group === "core" || stock.portfolio_group === "growth" || stock.portfolio_group === "mapping") {
			activeQuoteTotal += 1;
			if (stock.is_position) activeHoldingTotal += 1;
		}
	}

	return {
		total: snapshot.stocks.length,
		activeQuoteTotal,
		activeHoldingTotal,
		watchTotal,
		exitedWatchTotal: 0,
		coreTotal,
		growthTotal,
		mappingTotal,
	};
}

export function getActiveQuoteCodes(snapshot: QuoteSnapshot): string[] {
	return snapshot.stocks
		.filter((stock) => stock.portfolio_group === "core" || stock.portfolio_group === "growth" || stock.portfolio_group === "mapping")
		.map((stock) => stock.code);
}

export function getActiveQuoteKeys(snapshot: QuoteSnapshot): string[] {
	return snapshot.stocks
		.filter((stock) => stock.portfolio_group === "core" || stock.portfolio_group === "growth" || stock.portfolio_group === "mapping")
		.map(instrumentKey);
}

function compareUniverseToStock(universe: PortfolioUniverseItem, stock: QuoteStock, index: number): void {
	const fields: Array<keyof PortfolioUniverseItem> = [
		"code",
		"market",
		"exchange",
		"name",
		"group",
		"portfolio_group",
		"portfolio_status",
		"holding_status",
		"mapping_only",
		"mapped_to",
		"mapping_to",
		"position_qty",
		"is_position",
	];
	for (const field of fields) {
		if (universe[field] !== stock[field]) {
			throw new Error(`portfolio_universe[${index}] does not match stocks for ${instrumentKey(stock)}: ${field}`);
		}
	}
}

export function validateSnapshot(value: unknown, options: SnapshotValidationOptions = {}): asserts value is QuoteSnapshot {
	if (!isRecord(value)) throw new Error("upstream returned non-object JSON");
	if (value.portfolio_version !== EXPECTED_PORTFOLIO_VERSION) {
		throw new Error(`portfolio_version must be ${EXPECTED_PORTFOLIO_VERSION}`);
	}
	if (typeof value.snapshot_time !== "string" || !value.snapshot_time) {
		throw new Error("upstream JSON missing required field: snapshot_time");
	}
	if (typeof value.system_quality !== "string" || !value.system_quality) {
		throw new Error("upstream JSON missing required field: system_quality");
	}
	if (!isRecord(value.summary)) throw new Error("upstream JSON missing required field: summary");
	if (!isFiniteNumber(value.summary.total) || value.summary.total < 0 || !Number.isInteger(value.summary.total)) {
		throw new Error("summary.total must be a non-negative integer");
	}
	if (!Array.isArray(value.stocks)) throw new Error("upstream JSON missing required field: stocks");
	if (value.summary.total !== value.stocks.length) {
		throw new Error(`summary.total=${value.summary.total} but stocks.length=${value.stocks.length}`);
	}
	if (!Array.isArray(value.portfolio_universe)) throw new Error("upstream JSON missing required field: portfolio_universe");

	const stocks = value.stocks.map((stock, index) => validateStock(stock, index));
	const universe = value.portfolio_universe.map((item, index) => validateUniverseItem(item, index));
	if (universe.length !== stocks.length) throw new Error(`portfolio_universe.length=${universe.length} but stocks.length=${stocks.length}`);

	const stockByKey = new Map<string, QuoteStock>();
	for (const stock of stocks) {
		const key = instrumentKey(stock);
		if (stockByKey.has(key)) throw new Error(`duplicate instrument key: ${key}`);
		stockByKey.set(key, stock);
	}
	const universeKeys = new Set<string>();
	for (const [index, item] of universe.entries()) {
		const key = instrumentKey(item);
		if (universeKeys.has(key)) throw new Error(`duplicate portfolio universe key: ${key}`);
		universeKeys.add(key);
		const stock = stockByKey.get(key);
		if (!stock) throw new Error(`portfolio_universe instrument is missing from stocks: ${key}`);
		compareUniverseToStock(item, stock, index);
	}

	const expectedKeys = new Set<string>(EXPECTED_MARKET_CODE_KEYS);
	if (stocks.length !== expectedKeys.size) throw new Error(`portfolio snapshot must contain ${expectedKeys.size} instruments, got ${stocks.length}`);
	for (const key of expectedKeys) if (!stockByKey.has(key)) throw new Error(`portfolio snapshot is missing ${key}`);
	for (const key of stockByKey.keys()) if (!expectedKeys.has(key)) throw new Error(`unexpected portfolio instrument: ${key}`);

	const validatedSnapshot = { ...value, stocks, portfolio_universe: universe } as unknown as QuoteSnapshot;
	const counts = getSnapshotCounts(validatedSnapshot);
	const expectedActiveQuoteTotal = options.expectedActiveQuoteTotal ?? EXPECTED_ACTIVE_QUOTE_KEYS.length;
	if (counts.activeQuoteTotal !== expectedActiveQuoteTotal) throw new Error(`active quote count must be ${expectedActiveQuoteTotal}, got ${counts.activeQuoteTotal}`);
	const activeKeys = new Set(getActiveQuoteKeys(validatedSnapshot));
	for (const key of EXPECTED_ACTIVE_QUOTE_KEYS) if (!activeKeys.has(key)) throw new Error(`active quote set is missing ${key}`);
	for (const key of activeKeys) if (!EXPECTED_ACTIVE_QUOTE_KEYS.includes(key as (typeof EXPECTED_ACTIVE_QUOTE_KEYS)[number])) throw new Error(`unexpected active quote key: ${key}`);

	for (const key of REQUIRED_WATCH_KEYS) {
		const stock = stockByKey.get(key);
		if (!stock || stock.portfolio_group !== "watch" || stock.portfolio_status !== "WATCH" || stock.holding_status !== "WATCH") {
			throw new Error(`required Watch record is missing or misclassified: ${key}`);
		}
	}
	for (const key of REQUIRED_MAPPING_KEYS) {
		const stock = stockByKey.get(key);
		if (!stock || stock.portfolio_group !== "mapping" || !stock.mapping_only || stock.portfolio_status !== null || stock.holding_status !== "MAPPING_ONLY") {
			throw new Error(`required mapping record is missing or misclassified: ${key}`);
		}
	}
	if (counts.exitedWatchTotal !== 0) throw new Error("Exited Watch records are not allowed in v4");
	if ((options.requireWatch ?? true) && counts.watchTotal === 0) throw new Error("snapshot must include at least one Watch record");

	const derived: Record<string, number> = {
		active_quote_total: counts.activeQuoteTotal,
		active_holding_total: counts.activeHoldingTotal,
		watch_total: counts.watchTotal,
		exited_watch_total: 0,
		mapping_total: counts.mappingTotal,
		core_total: counts.coreTotal,
		growth_total: counts.growthTotal,
	};
	for (const field of DERIVED_SUMMARY_FIELDS) {
		if (!(field in value.summary)) continue;
		const supplied = value.summary[field];
		if (!isFiniteNumber(supplied) || !Number.isInteger(supplied) || supplied !== derived[field]) {
			throw new Error(`summary.${field} does not match derived value ${derived[field]}`);
		}
	}
}
