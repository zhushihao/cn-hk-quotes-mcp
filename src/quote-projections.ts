import { validateSnapshot, type QuoteStock } from "./portfolio-validation";

export const PUBLIC_QUOTE_SNAPSHOT_SCHEMA = "public_quote_snapshot/1" as const;

const PUBLIC_TOP_LEVEL_KEYS = new Set([
	"schema_version",
	"snapshot_time",
	"market_status",
	"source_mode",
	"system_quality",
	"summary",
	"stocks",
]);
const PUBLIC_SUMMARY_KEYS = new Set(["total", "usable"]);
const PUBLIC_STOCK_KEYS = new Set([
	"market",
	"exchange",
	"code",
	"name",
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
]);

const PUBLIC_STOCK_FIELDS = [
	"market",
	"exchange",
	"code",
	"name",
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
] as const satisfies ReadonlyArray<keyof QuoteStock>;

const FORBIDDEN_KEYS = new Set([
	"portfolio_universe",
	"portfolio_version",
	"portfolio_group",
	"portfolio_status",
	"holding_status",
	"mapping_only",
	"mapped_to",
	"mapping_to",
	"position_qty",
	"is_position",
	"active_holding_total",
	"active_quote_total",
	"watch_total",
	"exited_watch_total",
	"mapping_total",
	"core_total",
	"growth_total",
	"live_universe",
	"live_universe_hash",
	"live_universe_count",
	"live_universe_status",
	"active_count",
	"holding_count",
	"position_count",
	"account",
	"cost",
	"order",
	"orders",
	"credential",
	"credentials",
	"token",
	"secret",
]);

export type PublicQuoteStock = Pick<QuoteStock, (typeof PUBLIC_STOCK_FIELDS)[number]>;

export type PublicQuoteSnapshot = {
	schema_version: typeof PUBLIC_QUOTE_SNAPSHOT_SCHEMA;
	snapshot_time: string;
	market_status?: string;
	source_mode?: string;
	system_quality: string;
	summary: {
		total: number;
		usable?: number;
	};
	stocks: PublicQuoteStock[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, context: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`${context}.${key} is not allowed in public quote snapshot`);
	}
}

function assertNoForbiddenKeys(value: unknown, context: string): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertNoForbiddenKeys(item, `${context}[${index}]`));
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_KEYS.has(key)) throw new Error(`${context}.${key} is forbidden in public quote snapshot`);
		assertNoForbiddenKeys(child, `${context}.${key}`);
	}
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`snapshot.${field} must be a non-empty string when supplied`);
	}
	return value;
}

function optionalUsable(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		throw new Error("summary.usable must be a non-negative integer when supplied");
	}
	return value;
}

function pickPublicStock(stock: QuoteStock): PublicQuoteStock {
	return {
		market: stock.market,
		exchange: stock.exchange,
		code: stock.code,
		name: stock.name,
		price: stock.price,
		change: stock.change,
		change_pct: stock.change_pct,
		pre_close: stock.pre_close,
		prev_close: stock.prev_close,
		open: stock.open,
		high: stock.high,
		low: stock.low,
		pct_change: stock.pct_change,
		volume: stock.volume,
		amount: stock.amount,
		market_status: stock.market_status,
		market_data_time: stock.market_data_time,
		source_update_time: stock.source_update_time,
		freshness_basis: stock.freshness_basis,
		quote_time: stock.quote_time,
		fetch_time: stock.fetch_time,
		age_seconds: stock.age_seconds,
		primary_source: stock.primary_source,
		secondary_source: stock.secondary_source,
		source_status: stock.source_status,
		quality: stock.quality,
	};
}

export function assertPublicQuotePrivacy(value: unknown): asserts value is PublicQuoteSnapshot {
	if (!isRecord(value)) throw new Error("public quote snapshot must be an object");
	assertNoForbiddenKeys(value, "public_quote_snapshot");
	assertExactKeys(value, PUBLIC_TOP_LEVEL_KEYS, "public_quote_snapshot");
	if (value.schema_version !== PUBLIC_QUOTE_SNAPSHOT_SCHEMA) {
		throw new Error(`schema_version must be ${PUBLIC_QUOTE_SNAPSHOT_SCHEMA}`);
	}
	if (typeof value.snapshot_time !== "string" || value.snapshot_time.length === 0) {
		throw new Error("public_quote_snapshot.snapshot_time must be a non-empty string");
	}
	if (value.market_status !== undefined && (typeof value.market_status !== "string" || value.market_status.length === 0)) {
		throw new Error("public_quote_snapshot.market_status must be a non-empty string when supplied");
	}
	if (value.source_mode !== undefined && (typeof value.source_mode !== "string" || value.source_mode.length === 0)) {
		throw new Error("public_quote_snapshot.source_mode must be a non-empty string when supplied");
	}
	if (typeof value.system_quality !== "string" || value.system_quality.length === 0) {
		throw new Error("public_quote_snapshot.system_quality must be a non-empty string");
	}
	if (!isRecord(value.summary)) throw new Error("public_quote_snapshot.summary must be an object");
	assertExactKeys(value.summary, PUBLIC_SUMMARY_KEYS, "public_quote_snapshot.summary");
	if (typeof value.summary.total !== "number" || !Number.isInteger(value.summary.total) || value.summary.total < 0) {
		throw new Error("public_quote_snapshot.summary.total must be a non-negative integer");
	}
	if (value.summary.usable !== undefined && (typeof value.summary.usable !== "number" || !Number.isInteger(value.summary.usable) || value.summary.usable < 0)) {
		throw new Error("public_quote_snapshot.summary.usable must be a non-negative integer when supplied");
	}
	if (!Array.isArray(value.stocks)) throw new Error("public_quote_snapshot.stocks must be an array");
	if (value.summary.total !== value.stocks.length) {
		throw new Error("public_quote_snapshot.summary.total must match stocks.length");
	}
	for (const [index, stock] of value.stocks.entries()) {
		if (!isRecord(stock)) throw new Error(`public_quote_snapshot.stocks[${index}] must be an object`);
		assertExactKeys(stock, PUBLIC_STOCK_KEYS, `public_quote_snapshot.stocks[${index}]`);
	}
}

export function toPublicQuoteSnapshot(catalog: unknown): PublicQuoteSnapshot {
	validateSnapshot(catalog);

	const summary: PublicQuoteSnapshot["summary"] = {
		total: catalog.summary.total,
	};
	const projected: PublicQuoteSnapshot = {
		schema_version: PUBLIC_QUOTE_SNAPSHOT_SCHEMA,
		snapshot_time: catalog.snapshot_time,
		system_quality: catalog.system_quality,
		summary,
		stocks: catalog.stocks.map(pickPublicStock),
	};
	const marketStatus = optionalString(catalog.market_status, "market_status");
	const sourceMode = optionalString(catalog.source_mode, "source_mode");
	const usable = optionalUsable(catalog.summary.usable);
	if (marketStatus !== undefined) projected.market_status = marketStatus;
	if (sourceMode !== undefined) projected.source_mode = sourceMode;
	if (usable !== undefined) summary.usable = usable;

	assertPublicQuotePrivacy(projected);
	return projected;
}
