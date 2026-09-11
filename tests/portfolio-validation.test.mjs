import assert from "node:assert/strict";
import test from "node:test";

import {
	getActiveQuoteCodes,
	getSnapshotCounts,
	validateSnapshot,
} from "../src/portfolio-validation.ts";

const universeDefinitions = [
	["300308", "CN", "SZ", "Core", "core", "CORE", "ACTIVE", 400, true],
	["03308", "HK", "HK", "Core", "mapping", null, "MAPPING_ONLY", 0, false, "300308.SZ"],
	["300502", "CN", "SZ", "Core", "core", "CORE", "ACTIVE", 1500, true],
	["300394", "CN", "SZ", "Core", "core", "CORE", "ACTIVE", 1800, true],
	["688676", "CN", "SH", "Core", "core", "CORE", "ACTIVE", 2000, true],
	["601872", "CN", "SH", "Core", "core", "CORE", "ACTIVE", 5000, true],
	["588080", "CN", "SH", "Core", "core", "CORE", "ACTIVE", 30000, true],
	["09696", "HK", "HK", "Core", "core", "CORE", "ACTIVE", null, true],
	["002466", "CN", "SZ", "Core", "mapping", null, "MAPPING_ONLY", 0, false, "09696.HK"],
	["002192", "CN", "SZ", "Core", "core", "CORE", "ACTIVE", null, true],
	["300433", "CN", "SZ", "Growth", "growth", "GROWTH", "ACTIVE", 3000, true],
	["588170", "CN", "SH", "Growth", "growth", "GROWTH", "ACTIVE", 150000, true],
	["603308", "CN", "SH", "Growth", "growth", "GROWTH", "ACTIVE", 1000, true],
	["600096", "CN", "SH", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["605376", "CN", "SH", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["301183", "CN", "SZ", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["688596", "CN", "SH", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["09988", "HK", "HK", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["02228", "HK", "HK", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["603893", "CN", "SH", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["002460", "CN", "SZ", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["002240", "CN", "SZ", "Watch", "watch", "WATCH", "WATCH", 0, false],
	["002738", "CN", "SZ", "Watch", "watch", "WATCH", "WATCH", 0, false],
];

function makeStock(definition, overrides = {}) {
	const [code, market, exchange, group, portfolioGroup, portfolioStatus, holdingStatus, positionQty, isPosition, mappedTo] = definition;
	return {
		code, market, exchange, name: code, group,
		portfolio_group: portfolioGroup,
		portfolio_status: portfolioStatus,
		holding_status: holdingStatus,
		mapping_only: portfolioGroup === "mapping",
		mapped_to: mappedTo ?? null,
		mapping_to: mappedTo ?? null,
		position_qty: positionQty,
		is_position: isPosition,
		price: 10, change: 1, change_pct: 10, pre_close: 9, prev_close: 9, open: 9.5, high: 10.5, low: 9,
		pct_change: 10, volume: 100, amount: 1000,
		market_status: "CLOSED",
		market_data_time: "2026-08-28T15:00:00+08:00",
		source_update_time: "2026-08-28T15:01:00+08:00",
		freshness_basis: "MARKET_DATA",
		quote_time: "2026-08-28T15:00:00+08:00",
		fetch_time: "2026-08-28T15:01:00+08:00",
		age_seconds: 60, primary_source: "tencent", secondary_source: null,
		source_status: "FALLBACK", quality: "CLOSED_SNAPSHOT", ...overrides,
	};
}

function makeSnapshot(stocks, summary = {}) {
	const portfolioUniverse = stocks.map((stock) => ({
		code: stock.code, market: stock.market, exchange: stock.exchange, name: stock.name,
		group: stock.group, portfolio_group: stock.portfolio_group,
		portfolio_status: stock.portfolio_status, holding_status: stock.holding_status,
		mapping_only: stock.mapping_only, mapped_to: stock.mapped_to, mapping_to: stock.mapping_to,
		position_qty: stock.position_qty, is_position: stock.is_position,
	}));
	return {
		portfolio_version: "2026-09-01-v4", snapshot_time: "2026-08-28T15:01:00+08:00",
		market_status: "CLOSED", source_mode: "MULTI_SOURCE", system_quality: "DEGRADED",
		summary: { total: stocks.length, usable: stocks.length, ...summary }, portfolio_universe: portfolioUniverse, stocks,
	};
}

const allStocks = universeDefinitions.map((definition) => makeStock(definition));
const activeStocks = allStocks.filter((stock) => stock.portfolio_group !== "watch");

test("accepts a structurally complete snapshot without a fixed instrument/version allowlist", () => {
	const snapshot = makeSnapshot(allStocks);
	snapshot.portfolio_version = "live:sha256-dynamic";
	assert.doesNotThrow(() => validateSnapshot(snapshot));
	assert.deepEqual(getActiveQuoteCodes(snapshot), activeStocks.map((stock) => stock.code));
	assert.deepEqual(getSnapshotCounts(snapshot), { total: 23, activeQuoteTotal: 13, activeHoldingTotal: 11, watchTotal: 10, exitedWatchTotal: 0, coreTotal: 8, growthTotal: 3, mappingTotal: 2 });
});

test("accepts a smaller self-consistent universe and only enforces counts when requested", () => {
	const snapshot = makeSnapshot(activeStocks);
	assert.doesNotThrow(() => validateSnapshot(snapshot));
	assert.throws(() => validateSnapshot(snapshot, { expectedActiveQuoteTotal: 99 }), /active quote count/i);
});

test("accepts newly introduced market-qualified codes and still rejects duplicate keys", () => {
	const newHolding = makeStock(["002409", "CN", "SZ", "Core", "core", "CORE", "ACTIVE", null, true]);
	assert.doesNotThrow(() => validateSnapshot(makeSnapshot([...allStocks, newHolding])));
	assert.throws(() => validateSnapshot(makeSnapshot([...allStocks, { ...allStocks[0] }])), /duplicate instrument key/i);
});

test("validates row semantics instead of a fixed Watch/Mapping identity list", () => {
	const misclassifiedMapping = allStocks.map((stock) => stock.code === "002466"
		? { ...stock, group: "Watch", portfolio_group: "watch", portfolio_status: "WATCH", holding_status: "WATCH", mapping_only: false, mapped_to: null, mapping_to: null }
		: stock);
	assert.doesNotThrow(() => validateSnapshot(makeSnapshot(misclassifiedMapping)));
	const badMapping = allStocks.map((stock) => stock.code === "03308"
		? { ...stock, holding_status: "ACTIVE", is_position: true, position_qty: null }
		: stock);
	assert.throws(() => validateSnapshot(makeSnapshot(badMapping)), /mapping|MAPPING_ONLY/i);
	const exited = allStocks.map((stock) => stock.code === "605376"
		? { ...stock, portfolio_group: "exited_watch", portfolio_status: "WATCH", holding_status: "WATCH" }
		: stock);
	assert.throws(() => validateSnapshot(makeSnapshot(exited)), /portfolio_group|invalid|exited/i);
});

test("decouples research Watch bucket from LIVE holding status", () => {
	const heldWatch = allStocks.map((stock) => stock.code === "301183"
		? { ...stock, holding_status: "ACTIVE", is_position: true, position_qty: null }
		: stock);
	const snapshot = makeSnapshot(heldWatch);
	assert.doesNotThrow(() => validateSnapshot(snapshot));
	assert.equal(getSnapshotCounts(snapshot).activeHoldingTotal, 12);
});

test("requireWatch is opt-in instead of a fixed production identity guard", () => {
	const noWatch = makeSnapshot(allStocks.filter((stock) => stock.portfolio_group !== "watch"));
	assert.doesNotThrow(() => validateSnapshot(noWatch));
	assert.throws(() => validateSnapshot(noWatch, { requireWatch: true }), /at least one Watch/i);
});

test("checks derived summary totals and allows failed Watch quote values", () => {
	const valid = makeSnapshot(allStocks, { active_quote_total: 13, active_holding_total: 11, watch_total: 10, exited_watch_total: 0, mapping_total: 2, core_total: 8, growth_total: 3 });
	assert.doesNotThrow(() => validateSnapshot(valid));
	assert.throws(() => validateSnapshot(makeSnapshot(allStocks, { core_total: 7 })), /core_total/i);
	const failedWatch = allStocks.map((stock) => stock.code === "600096"
		? { ...stock, price: null, pre_close: null, open: null, high: null, low: null, pct_change: null, volume: null, amount: null, market_data_time: null, source_update_time: null, quote_time: null, age_seconds: null, source_status: "ERROR", quality: "SOURCE_ERROR" }
		: stock);
	assert.doesNotThrow(() => validateSnapshot(makeSnapshot(failedWatch)));
});

test("does not use pure numeric code matching for A/H mappings and 应流股份", () => {
	const mapping = allStocks.find((stock) => stock.code === "03308");
	const tianqiMapping = allStocks.find((stock) => stock.code === "002466");
	const yingliu = allStocks.find((stock) => stock.code === "603308");
	assert.equal(mapping?.market, "HK");
	assert.equal(tianqiMapping?.market, "CN");
	assert.equal(yingliu?.market, "CN");
	assert.equal(mapping?.mapped_to, "300308.SZ");
	assert.equal(tianqiMapping?.mapped_to, "09696.HK");
	assert.equal(yingliu?.portfolio_group, "growth");
	assert.equal(new Set(allStocks.map((stock) => `${stock.market}:${stock.code}`)).size, 23);
});
