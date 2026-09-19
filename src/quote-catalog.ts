import {
	createTencentQuoteProvider,
	fetchDynamicQuoteRows,
	type DynamicQuoteFetchOptions,
} from "./dynamic-quotes.ts";
import {
	getSnapshotCounts,
	validateSnapshot,
	type QuoteSnapshot,
	type QuoteStock,
} from "./portfolio-validation.ts";

export const QUOTE_CATALOG_SCHEMA = "quote-catalog/1" as const;
export const QUOTE_CATALOG_KV_KEY = "quote-catalog/current";

export type QuoteCatalogItem = Pick<
	QuoteStock,
	| "market"
	| "exchange"
	| "code"
	| "name"
	| "group"
	| "portfolio_group"
	| "portfolio_status"
	| "mapping_only"
	| "mapped_to"
	| "mapping_to"
>;

export type StoredQuoteCatalog = {
	schema_version: typeof QUOTE_CATALOG_SCHEMA;
	generated_at: string;
	source_catalog_version: string;
	items: QuoteCatalogItem[];
};

function keyOf(value: Pick<QuoteCatalogItem, "market" | "code">): string {
	return `${value.market}:${value.code}`;
}

function catalogItem(stock: QuoteStock): QuoteCatalogItem {
	return {
		market: stock.market,
		exchange: stock.exchange,
		code: stock.code,
		name: stock.name,
		group: stock.group,
		portfolio_group: stock.portfolio_group,
		portfolio_status: stock.portfolio_status,
		mapping_only: stock.mapping_only,
		mapped_to: stock.mapped_to,
		mapping_to: stock.mapping_to,
	};
}

export function quoteCatalogFromSnapshot(
	snapshot: unknown,
	now = new Date(),
): StoredQuoteCatalog {
	validateSnapshot(snapshot);
	const items = snapshot.stocks.map(catalogItem);
	const seen = new Set<string>();
	for (const item of items) {
		const key = keyOf(item);
		if (seen.has(key)) throw new Error(`quote catalog contains duplicate identity: ${key}`);
		seen.add(key);
	}
	return {
		schema_version: QUOTE_CATALOG_SCHEMA,
		generated_at: now.toISOString(),
		source_catalog_version: snapshot.portfolio_version,
		items,
	};
}

export function validateQuoteCatalog(value: unknown): asserts value is StoredQuoteCatalog {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("quote catalog must be an object");
	}
	const catalog = value as Record<string, unknown>;
	if (catalog.schema_version !== QUOTE_CATALOG_SCHEMA) {
		throw new Error(`quote catalog schema must be ${QUOTE_CATALOG_SCHEMA}`);
	}
	if (typeof catalog.generated_at !== "string" || !catalog.generated_at) {
		throw new Error("quote catalog generated_at is required");
	}
	if (typeof catalog.source_catalog_version !== "string" || !catalog.source_catalog_version) {
		throw new Error("quote catalog source_catalog_version is required");
	}
	if (!Array.isArray(catalog.items) || catalog.items.length === 0 || catalog.items.length > 200) {
		throw new Error("quote catalog items must contain 1-200 rows");
	}
	const seen = new Set<string>();
	for (const [index, raw] of catalog.items.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`quote catalog item ${index} must be an object`);
		}
		const item = raw as Record<string, unknown>;
		if (item.market !== "CN" && item.market !== "HK") {
			throw new Error(`quote catalog item ${index}.market is invalid`);
		}
		if (item.exchange !== "SZ" && item.exchange !== "SH" && item.exchange !== "HK") {
			throw new Error(`quote catalog item ${index}.exchange is invalid`);
		}
		if (typeof item.code !== "string" || !/^\d{5,6}$/.test(item.code)) {
			throw new Error(`quote catalog item ${index}.code is invalid`);
		}
		if (typeof item.name !== "string" || !item.name) {
			throw new Error(`quote catalog item ${index}.name is invalid`);
		}
		if (item.group !== "Core" && item.group !== "Growth" && item.group !== "Watch") {
			throw new Error(`quote catalog item ${index}.group is invalid`);
		}
		if (
			item.portfolio_group !== "core" &&
			item.portfolio_group !== "growth" &&
			item.portfolio_group !== "watch" &&
			item.portfolio_group !== "mapping"
		) {
			throw new Error(`quote catalog item ${index}.portfolio_group is invalid`);
		}
		if (typeof item.mapping_only !== "boolean") {
			throw new Error(`quote catalog item ${index}.mapping_only is invalid`);
		}
		const key = `${item.market}:${item.code}`;
		if (seen.has(key)) throw new Error(`quote catalog contains duplicate identity: ${key}`);
		seen.add(key);
	}
}

export async function writeQuoteCatalog(
	kv: KVNamespace,
	catalog: StoredQuoteCatalog,
): Promise<void> {
	validateQuoteCatalog(catalog);
	await kv.put(QUOTE_CATALOG_KV_KEY, JSON.stringify(catalog));
}

export async function readQuoteCatalog(kv: KVNamespace): Promise<StoredQuoteCatalog | null> {
	const raw = await kv.get(QUOTE_CATALOG_KV_KEY);
	if (!raw) return null;
	const parsed = JSON.parse(raw) as unknown;
	validateQuoteCatalog(parsed);
	return parsed;
}

function classifiedRow(row: QuoteStock, item: QuoteCatalogItem): QuoteStock {
	const mapping = item.portfolio_group === "mapping" || item.mapping_only;
	return {
		...row,
		name: item.name || row.name,
		group: item.group,
		portfolio_group: item.portfolio_group,
		portfolio_status: item.portfolio_status,
		holding_status: mapping ? "MAPPING_ONLY" : "WATCH",
		mapping_only: mapping,
		mapped_to: item.mapped_to,
		mapping_to: item.mapping_to,
		position_qty: 0,
		is_position: false,
	};
}

export async function fetchQuoteSnapshotFromCatalog(
	catalog: StoredQuoteCatalog,
	options: Partial<DynamicQuoteFetchOptions> = {},
): Promise<QuoteSnapshot> {
	validateQuoteCatalog(catalog);
	const now = options.now ?? new Date();
	const batch = await fetchDynamicQuoteRows(catalog.items, {
		fetchQuote: options.fetchQuote ?? createTencentQuoteProvider({ now }),
		now,
	});
	const byKey = new Map(catalog.items.map((item) => [keyOf(item), item]));
	const stocks = batch.rows.map((row) => {
		const item = byKey.get(keyOf(row));
		if (!item) throw new Error("provider returned identity outside private quote catalog");
		return classifiedRow(row, item);
	});
	const portfolioUniverse = stocks.map((stock) => ({
		code: stock.code,
		market: stock.market,
		exchange: stock.exchange,
		name: stock.name,
		group: stock.group,
		portfolio_group: stock.portfolio_group,
		portfolio_status: stock.portfolio_status,
		holding_status: stock.holding_status,
		mapping_only: stock.mapping_only,
		mapped_to: stock.mapped_to,
		mapping_to: stock.mapping_to,
		position_qty: stock.position_qty,
		is_position: stock.is_position,
	}));
	const provisional: QuoteSnapshot = {
		portfolio_version: `catalog:${catalog.generated_at}`,
		snapshot_time: now.toISOString(),
		market_status: stocks.some((row) => row.market_status === "OPEN") ? "OPEN" : "CLOSED",
		source_mode: "DIRECT_TENCENT",
		system_quality: "OK",
		summary: { total: stocks.length },
		portfolio_universe: portfolioUniverse,
		stocks,
	};
	const counts = getSnapshotCounts(provisional);
	provisional.summary = {
		total: counts.total,
		usable: counts.total,
		active_quote_total: counts.activeQuoteTotal,
		active_holding_total: counts.activeHoldingTotal,
		watch_total: counts.watchTotal,
		exited_watch_total: counts.exitedWatchTotal,
		mapping_total: counts.mappingTotal,
		core_total: counts.coreTotal,
		growth_total: counts.growthTotal,
	};
	validateSnapshot(provisional);
	return provisional;
}
