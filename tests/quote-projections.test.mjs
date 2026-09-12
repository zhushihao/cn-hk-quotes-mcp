import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Let the default resolver report the original error for non-TS imports.
			}
		}
		return nextResolve(specifier, context);
	},
});

const { assertPublicQuotePrivacy, toPublicQuoteSnapshot } = await import("../src/quote-projections.ts");

const PUBLIC_STOCK_KEYS = [
	"market", "exchange", "code", "name",
	"price", "change", "change_pct", "pre_close", "prev_close", "open", "high", "low", "pct_change",
	"volume", "amount",
	"market_status", "market_data_time", "source_update_time", "freshness_basis", "quote_time", "fetch_time",
	"age_seconds", "primary_source", "secondary_source", "source_status", "quality",
];

const PUBLIC_TOP_LEVEL_KEYS = [
	"schema_version", "snapshot_time", "market_status", "source_mode", "system_quality", "summary", "stocks",
];

const FORBIDDEN_KEYS = new Set([
	"portfolio_universe", "portfolio_version", "group", "portfolio_group", "portfolio_status", "holding_status",
	"mapping_only", "mapped_to", "mapping_to", "position_qty", "is_position", "active_holding_total",
	"active_quote_total", "watch_total", "exited_watch_total", "mapping_total", "core_total", "growth_total",
	"live_universe", "live_universe_hash", "live_universe_count", "live_universe_status", "active_count",
	"account", "cost", "order", "credential",
]);

function stock(code, market, exchange, portfolioGroup, portfolioStatus, holdingStatus, isPosition, mappingOnly = false) {
	return {
		market, exchange, code, name: `Name ${code}`,
		group: portfolioGroup === "growth" ? "Growth" : portfolioGroup === "watch" ? "Watch" : "Core",
		portfolio_group: portfolioGroup, portfolio_status: portfolioStatus,
		holding_status: holdingStatus, mapping_only: mappingOnly,
		mapped_to: mappingOnly ? "300308" : null, mapping_to: mappingOnly ? "300308" : null,
		position_qty: isPosition ? 100 : 0, is_position: isPosition,
		price: 10, change: 1, change_pct: 10, pre_close: 9, prev_close: 9, open: 9.5, high: 10.5, low: 9,
		pct_change: 10, volume: 100, amount: 1000, market_status: "CLOSED",
		market_data_time: "2026-09-11T15:00:00+08:00", source_update_time: "2026-09-11T15:01:00+08:00",
		freshness_basis: "MARKET_DATA", quote_time: "2026-09-11T15:00:00+08:00",
		fetch_time: "2026-09-11T15:01:00+08:00", age_seconds: 60,
		primary_source: "tencent", secondary_source: null, source_status: "OK", quality: "CLOSED_SNAPSHOT",
	};
}

function snapshotOf(stocks) {
	const portfolioUniverse = stocks.map((stock) => ({
		market: stock.market, exchange: stock.exchange, code: stock.code, name: stock.name,
		group: stock.group, portfolio_group: stock.portfolio_group, portfolio_status: stock.portfolio_status,
		holding_status: stock.holding_status, mapping_only: stock.mapping_only,
		mapped_to: stock.mapped_to, mapping_to: stock.mapping_to,
		position_qty: stock.position_qty, is_position: stock.is_position,
	}));
	return {
		portfolio_version: "catalog-v1",
		snapshot_time: "2026-09-11T15:01:00+08:00",
		market_status: "CLOSED", source_mode: "MULTI_SOURCE", system_quality: "OK",
		summary: { total: stocks.length, usable: stocks.length, active_holding_total: 2 },
		portfolio_universe: portfolioUniverse,
		stocks,
		live_universe: { content_hash: "sha256:catalog-only" },
	};
}

function collectKeys(value, keys = []) {
	if (!value || typeof value !== "object") return keys;
	if (Array.isArray(value)) {
		for (const item of value) collectKeys(item, keys);
		return keys;
	}
	for (const [key, child] of Object.entries(value)) {
		keys.push(key);
		collectKeys(child, keys);
	}
	return keys;
}

const catalog = snapshotOf([
	stock("300308", "CN", "SZ", "core", "CORE", "ACTIVE", true),
	stock("300502", "CN", "SZ", "growth", "GROWTH", "ACTIVE", true),
	stock("301183", "CN", "SZ", "watch", "WATCH", "WATCH", false),
	stock("03308", "HK", "HK", "mapping", null, "MAPPING_ONLY", false, true),
]);

test("public projection is a strict quote-only allowlist", () => {
	const projected = toPublicQuoteSnapshot(catalog);
	assert.equal(projected.schema_version, "public_quote_snapshot/1");
	assert.deepEqual(Object.keys(projected).sort(), PUBLIC_TOP_LEVEL_KEYS.sort());
	assert.deepEqual(Object.keys(projected.summary).sort(), ["total", "usable"]);
	assert.equal(projected.summary.total, catalog.stocks.length);
	assert.equal(projected.summary.usable, catalog.summary.usable);
	for (const row of projected.stocks) {
		assert.deepEqual(Object.keys(row).sort(), PUBLIC_STOCK_KEYS.sort());
	}
	assert.equal(collectKeys(projected).some((key) => FORBIDDEN_KEYS.has(key)), false);
});

test("public privacy assertion rejects forbidden fields even when nested", () => {
	const projected = toPublicQuoteSnapshot(catalog);
	assert.throws(
		() => assertPublicQuotePrivacy({ ...projected, metadata: { position_qty: 100 } }),
		/forbidden|not allowed/i,
	);
	assert.throws(
		() => assertPublicQuotePrivacy({ ...projected, stocks: [{ ...projected.stocks[0], is_position: false }] }),
		/forbidden|not allowed/i,
	);
});

test("public projection ignores private LIVE metadata", () => {
	const publicA = toPublicQuoteSnapshot(catalog);
	const publicB = toPublicQuoteSnapshot({ ...catalog, live_universe: { active: ["CN:300502"] } });
	assert.deepEqual(publicB, publicA);
	assert.deepEqual(
		publicA.stocks.map((row) => `${row.market}:${row.code}`),
		catalog.stocks.map((row) => `${row.market}:${row.code}`),
	);
});
