import assert from "node:assert/strict";
import test from "node:test";

import {
	getActiveQuoteCodes,
	getSnapshotCounts,
	validateSnapshot,
} from "../src/portfolio-validation.ts";

const universeDefinitions = [
	["300308", "CN", "SZ", "Core", "core", "ACTIVE", 400, true],
	["03308", "HK", "HK", "Core", "mapping", "MAPPING_ONLY", 0, false, "300308.SZ"],
	["300502", "CN", "SZ", "Core", "core", "ACTIVE", 1500, true],
	["300394", "CN", "SZ", "Core", "core", "ACTIVE", 1800, true],
	["688676", "CN", "SH", "Core", "core", "ACTIVE", 2000, true],
	["601872", "CN", "SH", "Core", "core", "ACTIVE", 5000, true],
	["588080", "CN", "SH", "Core", "core", "ACTIVE", 30000, true],
	["300433", "CN", "SZ", "Growth", "growth", "ACTIVE", 3000, true],
	["588170", "CN", "SH", "Growth", "growth", "ACTIVE", 150000, true],
	["603308", "CN", "SH", "Growth", "growth", "ACTIVE", 1000, true],
	["600096", "CN", "SH", "Watch", "watch", "WATCH", 0, false],
	["605376", "CN", "SH", "Watch", "exited_watch", "EXITED", 0, false],
	["301183", "CN", "SZ", "Watch", "exited_watch", "EXITED", 0, false],
	["688596", "CN", "SH", "Watch", "exited_watch", "EXITED", 0, false],
	["09988", "HK", "HK", "Watch", "watch", "WATCH", 0, false],
	["02228", "HK", "HK", "Watch", "watch", "WATCH", 0, false],
	["603893", "CN", "SH", "Watch", "watch", "WATCH", 0, false],
];

function makeStock(definition, overrides = {}) {
	const [code, market, exchange, group, portfolioGroup, holdingStatus, positionQty, isPosition, mappingTo] = definition;
	return {
		code,
		market,
		exchange,
		name: code,
		group,
		portfolio_group: portfolioGroup,
		holding_status: holdingStatus,
		mapping_to: mappingTo ?? null,
		position_qty: positionQty,
		is_position: isPosition,
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
	const portfolioUniverse = stocks.map((stock) => ({
		code: stock.code,
		market: stock.market,
		exchange: stock.exchange,
		name: stock.name,
		group: stock.group,
		portfolio_group: stock.portfolio_group,
		holding_status: stock.holding_status,
		mapping_to: stock.mapping_to,
		position_qty: stock.position_qty,
		is_position: stock.is_position,
	}));
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
		portfolio_universe: portfolioUniverse,
		stocks,
	};
}

const allStocks = universeDefinitions.map((definition) => makeStock(definition));
const activeStocks = allStocks.filter((stock) => stock.is_position || stock.holding_status === "MAPPING_ONLY");

test("accepts the complete 17-instrument snapshot and derives five layer counts", () => {
	const snapshot = makeSnapshot(allStocks);

	assert.doesNotThrow(() => validateSnapshot(snapshot));
	assert.deepEqual(getActiveQuoteCodes(snapshot), activeStocks.map((stock) => stock.code));
	assert.deepEqual(getSnapshotCounts(snapshot), {
		total: 17,
		activeQuoteTotal: 10,
		activeHoldingTotal: 9,
		watchTotal: 4,
		exitedWatchTotal: 3,
		coreTotal: 6,
		growthTotal: 3,
		mappingTotal: 1,
	});
});

test("rejects a legacy or partial snapshot without the Site universe", () => {
	assert.throws(() => validateSnapshot(makeSnapshot(activeStocks)), /portfolio_universe|17|instruments/i);
});

test("rejects a snapshot with an unexpected or missing market-qualified code", () => {
	const replaced = allStocks.map((stock) =>
		stock.code === "603308" ? { ...stock, code: "999999" } : stock,
	);
	const replacedSnapshot = makeSnapshot(replaced);
	assert.throws(() => validateSnapshot(replacedSnapshot), /603308|unexpected|missing/i);

	const missing = makeSnapshot(allStocks.filter((stock) => stock.code !== "603308"));
	assert.throws(() => validateSnapshot(missing), /17|missing/i);
});

test("requires Watch and Exited Watch records to remain present and correctly classified", () => {
	const missingExited = makeSnapshot(allStocks.filter((stock) => stock.code !== "605376"));
	assert.throws(() => validateSnapshot(missingExited), /605376|17|missing/i);

	const misclassified = allStocks.map((stock) =>
		stock.code === "601872"
			? { ...stock, portfolio_group: "watch", group: "Watch", holding_status: "WATCH", position_qty: 0, is_position: false }
			: stock,
	);
	assert.throws(() => validateSnapshot(makeSnapshot(misclassified)), /active|group|portfolio|Watch/i);
});

test("checks derived summary totals and allows null quote values for non-positions", () => {
	const valid = makeSnapshot(allStocks, {
		active_quote_total: 10,
		active_holding_total: 9,
		watch_total: 4,
		exited_watch_total: 3,
		mapping_total: 1,
		core_total: 6,
		growth_total: 3,
	});
	assert.doesNotThrow(() => validateSnapshot(valid));

	const invalid = makeSnapshot(allStocks, { core_total: 7 });
	assert.throws(() => validateSnapshot(invalid), /core_total/i);

	const failedWatch = allStocks.map((stock) =>
		stock.code === "600096"
			? {
				...stock,
				price: null,
				pre_close: null,
				open: null,
				high: null,
				low: null,
				pct_change: null,
				volume: null,
				amount: null,
				market_data_time: null,
				source_update_time: null,
				age_seconds: null,
				source_status: "ERROR",
				quality: "SOURCE_ERROR",
			}
			: stock,
	);
	assert.doesNotThrow(() => validateSnapshot(makeSnapshot(failedWatch)));
});

test("does not use pure numeric code matching for 03308 and 603308", () => {
	const mapping = allStocks.find((stock) => stock.code === "03308");
	const yingliu = allStocks.find((stock) => stock.code === "603308");
	assert.equal(mapping?.market, "HK");
	assert.equal(yingliu?.market, "CN");
	assert.equal(mapping?.portfolio_group, "mapping");
	assert.equal(yingliu?.portfolio_group, "growth");
	assert.equal(new Set(allStocks.map((stock) => `${stock.market}:${stock.code}`)).size, 17);
});
