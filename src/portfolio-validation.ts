export type QuoteGroup = "Core" | "Growth" | "Watch";
export type HoldingStatus = "ACTIVE" | "MAPPING_ONLY" | "WATCH";

export type QuoteStock = {
	code: string;
	market: string;
	name: string;
	group: QuoteGroup;
	holding_status: HoldingStatus;
	mapping_to: string | null;
	[key: string]: unknown;
};

export type QuoteSummary = {
	total: number;
	[key: string]: unknown;
};

export type QuoteSnapshot = {
	snapshot_time: string;
	system_quality: string;
	summary: QuoteSummary;
	stocks: QuoteStock[];
	[key: string]: unknown;
};

export type SnapshotCounts = {
	total: number;
	activeQuoteTotal: number;
	activeHoldingTotal: number;
	watchTotal: number;
	coreTotal: number;
	growthTotal: number;
	mappingOnlyTotal: number;
};

export type SnapshotValidationOptions = {
	expectedActiveQuoteTotal?: number;
	requireWatch?: boolean;
};

// The active quote set is intentionally explicit: the H-share mapping counts
// as an active quote record, while the five baseline Watch records must remain
// queryable without being counted as active.
export const EXPECTED_ACTIVE_QUOTE_CODES = [
	"300308",
	"03308",
	"300502",
	"300394",
	"688676",
	"605376",
	"301183",
	"300433",
	"688596",
	"588170",
] as const;

export const REQUIRED_WATCH_CODES = [
	"601872",
	"09988",
	"02228",
	"603893",
	"600096",
] as const;

const GROUPS = new Set<QuoteGroup>(["Core", "Growth", "Watch"]);
const HOLDING_STATUSES = new Set<HoldingStatus>(["ACTIVE", "MAPPING_ONLY", "WATCH"]);

const REQUIRED_STOCK_FIELDS = [
	"code",
	"market",
	"name",
	"group",
	"holding_status",
	"mapping_to",
	"price",
	"pre_close",
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
	"source_status",
	"quality",
] as const;

const DERIVED_SUMMARY_FIELDS: Array<keyof SnapshotCounts | string> = [
	"active_quote_total",
	"active_holding_total",
	"watch_total",
	"core_total",
	"growth_total",
];

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

function validateStock(value: unknown, index: number): QuoteStock {
	const context = `stocks[${index}]`;
	if (!isRecord(value)) {
		throw new Error(`${context} must be an object`);
	}

	for (const field of REQUIRED_STOCK_FIELDS) {
		if (!(field in value)) {
			throw new Error(`${context}.${field} is required`);
		}
	}

	requireString(value, "code", context);
	requireString(value, "market", context);
	requireString(value, "name", context);
	const group = value.group;
	const holdingStatus = value.holding_status;
	if (typeof group !== "string" || !GROUPS.has(group as QuoteGroup)) {
		throw new Error(`${context}.group must be Core, Growth, or Watch`);
	}
	if (
		typeof holdingStatus !== "string" ||
		!HOLDING_STATUSES.has(holdingStatus as HoldingStatus)
	) {
		throw new Error(`${context}.holding_status must be ACTIVE, MAPPING_ONLY, or WATCH`);
	}

	const normalizedGroup = group as QuoteGroup;
	const normalizedStatus = holdingStatus as HoldingStatus;
	const mappingTo = value.mapping_to;
	if (mappingTo !== null && typeof mappingTo !== "string") {
		throw new Error(`${context}.mapping_to must be a string or null`);
	}
	if (normalizedStatus === "MAPPING_ONLY") {
		if (normalizedGroup === "Watch" || typeof mappingTo !== "string" || !mappingTo) {
			throw new Error(
				`${context}.MAPPING_ONLY records require a non-empty mapping_to and a Core/Growth group`,
			);
		}
	} else if (mappingTo !== null) {
		throw new Error(`${context}.mapping_to is only allowed for MAPPING_ONLY records`);
	}

	if (normalizedGroup === "Watch" && normalizedStatus !== "WATCH") {
		throw new Error(`${context}.Watch records must use holding_status WATCH`);
	}
	if (normalizedGroup !== "Watch" && normalizedStatus === "WATCH") {
		throw new Error(`${context}.Core/Growth records cannot use holding_status WATCH`);
	}

	const numericFields = [
		"price",
		"pre_close",
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
		const nullableWatchField = normalizedStatus === "WATCH" && fieldValue === null;
		if (!isFiniteNumber(fieldValue) && !nullableWatchField) {
			throw new Error(`${context}.${field} must be a finite number`);
		}
	}

	for (const field of ["market_status", "freshness_basis", "source_status", "quality"] as const) {
		requireString(value, field, context);
	}

	for (const field of ["market_data_time", "quote_time", "source_update_time"] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue !== "string" && fieldValue !== null) {
			throw new Error(`${context}.${field} must be a string or null`);
		}
	}
	requireString(value, "fetch_time", context);

	return value as QuoteStock;
}

export function getSnapshotCounts(snapshot: QuoteSnapshot): SnapshotCounts {
	let activeQuoteTotal = 0;
	let activeHoldingTotal = 0;
	let watchTotal = 0;
	let coreTotal = 0;
	let growthTotal = 0;
	let mappingOnlyTotal = 0;

	for (const stock of snapshot.stocks) {
		if (stock.group === "Core") {
			coreTotal += 1;
		}
		if (stock.group === "Growth") {
			growthTotal += 1;
		}
		if (stock.group === "Watch") {
			watchTotal += 1;
		}
		if (stock.holding_status === "MAPPING_ONLY") {
			mappingOnlyTotal += 1;
		}
		if (
			(stock.group === "Core" || stock.group === "Growth") &&
			(stock.holding_status === "ACTIVE" || stock.holding_status === "MAPPING_ONLY")
		) {
			activeQuoteTotal += 1;
			if (stock.holding_status === "ACTIVE") {
				activeHoldingTotal += 1;
			}
		}
	}

	return {
		total: snapshot.stocks.length,
		activeQuoteTotal,
		activeHoldingTotal,
		watchTotal,
		coreTotal,
		growthTotal,
		mappingOnlyTotal,
	};
}

export function getActiveQuoteCodes(snapshot: QuoteSnapshot): string[] {
	return snapshot.stocks
		.filter(
			(stock) =>
				(stock.group === "Core" || stock.group === "Growth") &&
				(stock.holding_status === "ACTIVE" || stock.holding_status === "MAPPING_ONLY"),
		)
		.map((stock) => stock.code);
}

export function validateSnapshot(
	value: unknown,
	options: SnapshotValidationOptions = {},
): asserts value is QuoteSnapshot {
	if (!isRecord(value)) {
		throw new Error("upstream returned non-object JSON");
	}

	const snapshotTime = value.snapshot_time;
	const systemQuality = value.system_quality;
	if (typeof snapshotTime !== "string" || !snapshotTime) {
		throw new Error("upstream JSON missing required field: snapshot_time");
	}
	if (typeof systemQuality !== "string" || !systemQuality) {
		throw new Error("upstream JSON missing required field: system_quality");
	}
	if (!isRecord(value.summary)) {
		throw new Error("upstream JSON missing required field: summary");
	}
	if (!isFiniteNumber(value.summary.total) || value.summary.total < 0) {
		throw new Error("summary.total must be a non-negative number");
	}
	if (!Number.isInteger(value.summary.total)) {
		throw new Error("summary.total must be an integer");
	}
	if (!Array.isArray(value.stocks)) {
		throw new Error("upstream JSON missing required field: stocks");
	}
	if (value.summary.total !== value.stocks.length) {
		throw new Error(
			`summary.total=${value.summary.total} but stocks.length=${value.stocks.length}`,
		);
	}

	const stocks = value.stocks.map((stock, index) => validateStock(stock, index));
	const codes = new Set<string>();
	for (const stock of stocks) {
		if (codes.has(stock.code)) {
			throw new Error(`duplicate stock code: ${stock.code}`);
		}
		codes.add(stock.code);
	}

	const validatedSnapshot = { ...value, stocks } as unknown as QuoteSnapshot;
	const counts = getSnapshotCounts(validatedSnapshot);
	const expectedActiveQuoteTotal = options.expectedActiveQuoteTotal ?? 10;
	if (counts.activeQuoteTotal !== expectedActiveQuoteTotal) {
		throw new Error(
			`active quote count must be ${expectedActiveQuoteTotal}, got ${counts.activeQuoteTotal}`,
		);
	}
	const activeCodes = getActiveQuoteCodes(validatedSnapshot);
	const expectedActiveCodes = new Set<string>(EXPECTED_ACTIVE_QUOTE_CODES);
	const actualActiveCodes = new Set(activeCodes);
	for (const code of EXPECTED_ACTIVE_QUOTE_CODES) {
		if (!actualActiveCodes.has(code)) {
			throw new Error(`active quote set is missing ${code}`);
		}
	}
	for (const code of activeCodes) {
		if (!expectedActiveCodes.has(code)) {
			throw new Error(`unexpected active quote code: ${code}`);
		}
	}
	for (const code of REQUIRED_WATCH_CODES) {
		const stock = stocks.find((candidate) => candidate.code === code);
		if (!stock || stock.group !== "Watch" || stock.holding_status !== "WATCH") {
			throw new Error(`required Watch record is missing or misclassified: ${code}`);
		}
	}
	if ((options.requireWatch ?? true) && counts.watchTotal === 0) {
		throw new Error("snapshot must include at least one Watch record");
	}

	const summary = value.summary;
	const derivedSummaryValues: Record<string, number> = {
		active_quote_total: counts.activeQuoteTotal,
		active_holding_total: counts.activeHoldingTotal,
		watch_total: counts.watchTotal,
		core_total: counts.coreTotal,
		growth_total: counts.growthTotal,
	};
	for (const field of DERIVED_SUMMARY_FIELDS) {
		if (!(field in summary)) {
			continue;
		}
		const supplied = summary[field];
		if (!isFiniteNumber(supplied) || !Number.isInteger(supplied)) {
			throw new Error(`summary.${field} must be an integer`);
		}
		if (supplied !== derivedSummaryValues[field]) {
			throw new Error(
				`summary.${field}=${supplied} but derived value is ${derivedSummaryValues[field]}`,
			);
		}
	}
}
