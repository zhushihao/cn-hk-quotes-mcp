import type { QuoteSnapshot, QuoteStock } from "./portfolio-validation";

export const LIVE_UNIVERSE_SCHEMA = "quote-universe/1" as const;
export const LIVE_UNIVERSE_KV_KEY = "live-portfolio/current";
export const DEFAULT_LIVE_UNIVERSE_MAX_AGE_SECONDS = 10 * 24 * 60 * 60;

export type LiveUniverseItem = {
	market: "CN" | "HK";
	exchange: "SH" | "SZ" | "BJ" | "HK";
	code: string;
};

export type LiveUniversePayload = {
	schema_version: typeof LIVE_UNIVERSE_SCHEMA;
	as_of: string;
	content_hash: string;
	active: LiveUniverseItem[];
};

export type StoredLiveUniverse = LiveUniversePayload & {
	received_at: string;
};

export type LiveUniverseCoverage = {
	status: "COMPLETE" | "INCOMPLETE";
	active_count: number;
	quoted_active_count: number;
	missing_active: string[];
};

const TOP_LEVEL_KEYS = new Set(["schema_version", "as_of", "content_hash", "active"]);
const ITEM_KEYS = new Set(["market", "exchange", "code"]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, context: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`${context}.${key} is not allowed`);
	}
}

function normalizeItem(value: unknown, index: number): LiveUniverseItem {
	const context = `active[${index}]`;
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	assertExactKeys(value, ITEM_KEYS, context);
	const market = value.market;
	const exchange = value.exchange;
	const code = value.code;
	if (market !== "CN" && market !== "HK") throw new Error(`${context}.market must be CN or HK`);
	if (exchange !== "SH" && exchange !== "SZ" && exchange !== "BJ" && exchange !== "HK") {
		throw new Error(`${context}.exchange is invalid`);
	}
	if ((market === "HK" && exchange !== "HK") || (market === "CN" && exchange === "HK")) {
		throw new Error(`${context}.market and exchange are inconsistent`);
	}
	if (typeof code !== "string" || !/^\d{5,6}$/.test(code)) {
		throw new Error(`${context}.code must be a 5-6 digit string`);
	}
	return { market, exchange, code };
}

function canonicalActive(active: LiveUniverseItem[]): LiveUniverseItem[] {
	return active
		.map((item) => ({ market: item.market, exchange: item.exchange, code: item.code }))
		.sort((a, b) => `${a.market}:${a.exchange}:${a.code}`.localeCompare(`${b.market}:${b.exchange}:${b.code}`));
}

export function liveInstrumentKey(item: Pick<LiveUniverseItem, "market" | "code">): string {
	return `${item.market}:${item.code}`;
}

export async function computeLiveUniverseHash(active: LiveUniverseItem[]): Promise<string> {
	const canonical = JSON.stringify({ active: canonicalActive(active) });
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `sha256:${hex}`;
}

export async function validateLiveUniverse(value: unknown): Promise<LiveUniversePayload> {
	if (!isRecord(value)) throw new Error("quote universe must be an object");
	assertExactKeys(value, TOP_LEVEL_KEYS, "quote_universe");
	if (value.schema_version !== LIVE_UNIVERSE_SCHEMA) {
		throw new Error(`schema_version must be ${LIVE_UNIVERSE_SCHEMA}`);
	}
	if (typeof value.as_of !== "string" || !value.as_of.trim()) throw new Error("as_of must be a non-empty string");
	if (typeof value.content_hash !== "string" || !HASH_PATTERN.test(value.content_hash)) {
		throw new Error("content_hash must be sha256:<64 lowercase hex>");
	}
	if (!Array.isArray(value.active)) throw new Error("active must be an array");
	if (value.active.length > 200) throw new Error("active may contain at most 200 instruments");

	const active = value.active.map(normalizeItem);
	const seen = new Set<string>();
	for (const item of active) {
		const key = liveInstrumentKey(item);
		if (seen.has(key)) throw new Error(`duplicate active instrument: ${key}`);
		seen.add(key);
	}
	const computed = await computeLiveUniverseHash(active);
	if (computed !== value.content_hash) throw new Error(`content_hash mismatch: expected ${computed}`);
	return {
		schema_version: LIVE_UNIVERSE_SCHEMA,
		as_of: value.as_of,
		content_hash: value.content_hash,
		active: canonicalActive(active),
	};
}

export async function writeLiveUniverse(
	kv: KVNamespace,
	value: unknown,
	receivedAt = new Date().toISOString(),
): Promise<StoredLiveUniverse> {
	const validated = await validateLiveUniverse(value);
	const stored: StoredLiveUniverse = { ...validated, received_at: receivedAt };
	await kv.put(LIVE_UNIVERSE_KV_KEY, JSON.stringify(stored));
	return stored;
}

export async function readLiveUniverse(kv: KVNamespace): Promise<StoredLiveUniverse | null> {
	const raw = await kv.get(LIVE_UNIVERSE_KV_KEY);
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("stored quote universe is invalid JSON");
	}
	if (!isRecord(parsed) || typeof parsed.received_at !== "string" || !parsed.received_at) {
		throw new Error("stored quote universe is missing received_at");
	}
	const receivedAt = parsed.received_at;
	const payload = { ...parsed };
	delete payload.received_at;
	const validated = await validateLiveUniverse(payload);
	return { ...validated, received_at: receivedAt };
}

export function assertLiveUniverseFresh(
	universe: StoredLiveUniverse,
	now = new Date(),
	maxAgeSeconds = DEFAULT_LIVE_UNIVERSE_MAX_AGE_SECONDS,
): void {
	const asOf = Date.parse(universe.as_of);
	if (!Number.isFinite(asOf)) throw new Error("quote universe as_of is not a valid timestamp");
	const ageSeconds = (now.getTime() - asOf) / 1000;
	if (ageSeconds < -300) throw new Error(`quote universe as_of is ${Math.round(-ageSeconds)}s in the future`);
	if (ageSeconds > maxAgeSeconds) {
		throw new Error(`quote universe is stale: age=${Math.round(ageSeconds)}s max=${maxAgeSeconds}s`);
	}
}

export function getLiveUniverseCoverage(
	snapshot: QuoteSnapshot,
	universe: StoredLiveUniverse,
): LiveUniverseCoverage {
	const quoted = new Set(snapshot.stocks.map((stock) => liveInstrumentKey(stock)));
	const missing = universe.active.map(liveInstrumentKey).filter((key) => !quoted.has(key));
	return {
		status: missing.length === 0 ? "COMPLETE" : "INCOMPLETE",
		active_count: universe.active.length,
		quoted_active_count: universe.active.length - missing.length,
		missing_active: missing,
	};
}

function toUniverseItem(stock: QuoteStock) {
	return {
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
	};
}

export function applyLiveUniverse(snapshot: QuoteSnapshot, universe: StoredLiveUniverse): QuoteSnapshot {
	const active = new Set(universe.active.map(liveInstrumentKey));
	const stocks: QuoteStock[] = [];
	for (const original of snapshot.stocks) {
		const key = liveInstrumentKey(original);
		if (original.mapping_only || original.portfolio_group === "mapping") {
			stocks.push({ ...original, is_position: false, position_qty: 0, holding_status: "MAPPING_ONLY" });
			continue;
		}
		const held = active.has(key);
		if (original.portfolio_group === "watch") {
			stocks.push({
				...original,
				holding_status: held ? "ACTIVE" : "WATCH",
				is_position: held,
				position_qty: held ? null : 0,
			});
			continue;
		}
		if (held) stocks.push({ ...original, holding_status: "ACTIVE", is_position: true, position_qty: null });
	}

	const portfolioUniverse = stocks.map(toUniverseItem);
	let coreTotal = 0;
	let growthTotal = 0;
	let watchTotal = 0;
	let mappingTotal = 0;
	let activeHoldingTotal = 0;
	for (const stock of stocks) {
		if (stock.portfolio_group === "core") coreTotal += 1;
		if (stock.portfolio_group === "growth") growthTotal += 1;
		if (stock.portfolio_group === "watch") watchTotal += 1;
		if (stock.portfolio_group === "mapping") mappingTotal += 1;
		if (stock.is_position) activeHoldingTotal += 1;
	}

	return {
		...snapshot,
		portfolio_version: `live:${universe.content_hash}`,
		live_universe: {
			schema_version: universe.schema_version,
			as_of: universe.as_of,
			content_hash: universe.content_hash,
			received_at: universe.received_at,
			active_count: universe.active.length,
		},
		summary: {
			...snapshot.summary,
			total: stocks.length,
			active_quote_total: activeHoldingTotal + mappingTotal,
			active_holding_total: activeHoldingTotal,
			watch_total: watchTotal,
			exited_watch_total: 0,
			mapping_total: mappingTotal,
			core_total: coreTotal,
			growth_total: growthTotal,
		},
		portfolio_universe: portfolioUniverse,
		stocks,
	};
}
