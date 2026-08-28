import assert from "node:assert/strict";
import test from "node:test";

import {
	getSnapshotCounts,
	validateSnapshot,
} from "../src/portfolio-validation.ts";

function makeStock(code, group, holdingStatus, overrides = {}) {
	return {
		code,
		market: code.startsWith("0") ? "HK" : "CN",
		name: code,
		group,
		holding_status: holdingStatus,
		mapping_to: null,
		price: 10,
		pre_close: 9,
		open: 9.5,
		high: 10.5,
		low: 9,
		pct_change: 10,
		volume: 100,
		amount: 1000,
		market_status: "CLOSED",
		market_data_time: null,
		source_update_time: "2026-08-28T15:00:00+08:00",
		freshness_basis: "SOURCE_LATEST",
		quote_time: null,
		fetch_time: "2026-08-28T15:01:00+08:00",
		age_seconds: 60,
		primary_source: "tencent",
		secondary_source: null,
		source_status: "FALLBACK",
		quality: "CLOSED_SNAPSHOT",
		...overrides,
	};
}

function makeSnapshot(stocks, summary = {}) {
	return {
		snapshot_time: "2026-08-28T15:01:00+08:00",
		market_status: "CLOSED",
		source_mode: "MULTI_SOURCE",
		system_quality: "DEGRADED",
		summary: {
			total: stocks.length,
			usable: stocks.length,
			...summary,
		},
		stocks,
	};
}

const activeStocks = [
	makeStock("300308", "Core", "ACTIVE"),
	makeStock("03308", "Core", "MAPPING_ONLY", { mapping_to: "300308.SZ" }),
	makeStock("300502", "Core", "ACTIVE"),
	makeStock("300394", "Core", "ACTIVE"),
	makeStock("688676", "Core", "ACTIVE"),
	makeStock("605376", "Growth", "ACTIVE"),
	makeStock("301183", "Growth", "ACTIVE"),
	makeStock("300433", "Growth", "ACTIVE"),
	makeStock("688596", "Growth", "ACTIVE"),
	makeStock("588170", "Growth", "ACTIVE"),
];

const watchStocks = [
	makeStock("601872", "Watch", "WATCH"),
	makeStock("09988", "Watch", "WATCH"),
	makeStock("02228", "Watch", "WATCH"),
	makeStock("603893", "Watch", "WATCH"),
	makeStock("600096", "Watch", "WATCH"),
];

test("accepts a full snapshot and derives separate active/watch counts", () => {
	const snapshot = makeSnapshot([...activeStocks, ...watchStocks]);

	assert.doesNotThrow(() => validateSnapshot(snapshot));
	assert.deepEqual(getSnapshotCounts(snapshot), {
		total: 15,
		activeQuoteTotal: 10,
		activeHoldingTotal: 9,
		watchTotal: 5,
		coreTotal: 5,
		growthTotal: 5,
		mappingOnlyTotal: 1,
	});
});

test("rejects a legacy active-only snapshot when Watch coverage is required", () => {
	assert.throws(
		() => validateSnapshot(makeSnapshot(activeStocks)),
		/Watch/i,
	);
});

test("rejects snapshots whose active quote count is not ten", () => {
	const snapshot = makeSnapshot([
		...activeStocks.slice(0, -1),
		...watchStocks,
	]);

	assert.throws(
		() => validateSnapshot(snapshot),
		/active.*10|10.*active/i,
	);
});

test("rejects inconsistent group and holding status combinations", () => {
	const snapshot = makeSnapshot([
		...activeStocks,
		...watchStocks.slice(0, -1),
		makeStock("600096", "Growth", "WATCH"),
	]);

	assert.throws(() => validateSnapshot(snapshot), /Watch|holding_status|group/i);
});

test("requires an H-share mapping target for MAPPING_ONLY records", () => {
	const invalidMapping = activeStocks.map((stock) =>
		stock.code === "03308" ? { ...stock, mapping_to: null } : stock,
	);

	assert.throws(
		() => validateSnapshot(makeSnapshot([...invalidMapping, ...watchStocks])),
		/mapping_to/i,
	);
});

test("rejects summary totals that do not equal the returned stock array", () => {
	const snapshot = makeSnapshot([...activeStocks, ...watchStocks], { total: 10 });

	assert.throws(() => validateSnapshot(snapshot), /summary\.total/i);
});

test("checks optional derived summary fields when the Site provides them", () => {
	const valid = makeSnapshot([...activeStocks, ...watchStocks], {
		active_quote_total: 10,
		watch_total: 5,
		core_total: 5,
		growth_total: 5,
	});
	assert.doesNotThrow(() => validateSnapshot(valid));

	const invalid = makeSnapshot([...activeStocks, ...watchStocks], {
		active_quote_total: 9,
	});
	assert.throws(() => validateSnapshot(invalid), /active_quote_total/i);
});
