import assert from "node:assert/strict";
import test from "node:test";

import {
	DynamicQuoteError,
	canonicalizeIdentity,
	createTencentQuoteProvider,
	fetchTencentQuote,
	fetchDynamicQuoteRows,
	mergeDynamicQuoteRows,
	parseTencentQuoteResponse,
	resolveTencentSymbol,
} from "../src/dynamic-quotes.ts";
import { validateSnapshot } from "../src/portfolio-validation.ts";

const NOW = new Date("2026-09-13T10:00:00+08:00");
const QUOTE_FIELDS = new Set([
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

function providerQuote(name, overrides = {}) {
	return {
		name,
		price: 10,
		change: 1,
		change_pct: 11.1111,
		pre_close: 9,
		prev_close: 9,
		open: 9.5,
		high: 10.5,
		low: 9,
		volume: 100,
		amount: 1000,
		market_status: "OPEN",
		market_data_time: "2026-09-13T09:59:00+08:00",
		source_update_time: "2026-09-13T09:59:01+08:00",
		quote_time: "2026-09-13T09:59:00+08:00",
		...overrides,
	};
}

function tencentPayload(
	symbol,
	{ market = "CN", code, name = "Demo", amount = "1000", quoteTime = "20260913095900" } = {},
) {
	const fields = Array.from({ length: 40 }, () => "");
	fields[0] = market === "HK" ? "100" : "1";
	fields[1] = name;
	fields[2] = code;
	fields[3] = "10";
	fields[4] = "9";
	fields[5] = "9.5";
	fields[6] = "100";
	fields[8] = "0";
	fields[35] = market === "HK" ? "10" : `10/100/${amount}`;
	fields[30] = market === "HK" ? "2026/09/13 09:59:00" : quoteTime;
	fields[31] = "1";
	fields[32] = "11.1111";
	fields[33] = "10.5";
	fields[34] = "9";
	if (market === "HK") fields[37] = amount;
	return `v_${symbol}="${fields.join("~")}";`;
}

function existingStock(code = "600000", exchange = "SH") {
	return {
		code,
		market: "CN",
		exchange,
		name: "Existing",
		group: "Core",
		portfolio_group: "core",
		portfolio_status: "CORE",
		holding_status: "ACTIVE",
		mapping_only: false,
		mapped_to: null,
		mapping_to: null,
		position_qty: null,
		is_position: true,
		price: 10,
		change: 1,
		change_pct: 11.1111,
		pre_close: 9,
		prev_close: 9,
		open: 9.5,
		high: 10.5,
		low: 9,
		pct_change: 11.1111,
		volume: 100,
		amount: 1000,
		market_status: "OPEN",
		market_data_time: "2026-09-13T09:59:00+08:00",
		source_update_time: "2026-09-13T09:59:01+08:00",
		freshness_basis: "MARKET_DATA",
		quote_time: "2026-09-13T09:59:00+08:00",
		fetch_time: "2026-09-13T10:00:00+08:00",
		age_seconds: 60,
		primary_source: "tencent",
		secondary_source: null,
		source_status: "OK",
		quality: "LIVE_QUOTE",
	};
}

function snapshotOf(stocks) {
	return {
		portfolio_version: "live:baseline",
		snapshot_time: "2026-09-13T10:00:00+08:00",
		system_quality: "OK",
		summary: {
			total: stocks.length,
			active_quote_total: stocks.filter((stock) => stock.is_position || stock.mapping_only)
				.length,
			active_holding_total: stocks.filter((stock) => stock.is_position).length,
			watch_total: stocks.filter((stock) => stock.portfolio_group === "watch").length,
			exited_watch_total: 0,
			mapping_total: stocks.filter((stock) => stock.portfolio_group === "mapping").length,
			core_total: stocks.filter((stock) => stock.portfolio_group === "core").length,
			growth_total: stocks.filter((stock) => stock.portfolio_group === "growth").length,
		},
		portfolio_universe: stocks.map((stock) =>
			Object.fromEntries(Object.entries(stock).filter(([key]) => !QUOTE_FIELDS.has(key))),
		),
		stocks,
	};
}

test("canonical CN/HK identities resolve to Tencent symbols", () => {
	const sh = canonicalizeIdentity({ market: "CN", exchange: "SH", code: "600000" });
	const sz = canonicalizeIdentity({ market: "cn", exchange: "sz", code: "000001" });
	const hk = canonicalizeIdentity({ market: "HK", exchange: "HK", code: "00700" });

	assert.deepEqual(sh, { market: "CN", exchange: "SH", code: "600000" });
	assert.deepEqual(sz, { market: "CN", exchange: "SZ", code: "000001" });
	assert.deepEqual(hk, { market: "HK", exchange: "HK", code: "00700" });
	assert.equal(resolveTencentSymbol(sh), "sh600000");
	assert.equal(resolveTencentSymbol(sz), "sz000001");
	assert.equal(resolveTencentSymbol(hk), "hk00700");
});

test("invalid code and BJ are explicit structured identity errors", () => {
	assert.throws(
		() => canonicalizeIdentity({ market: "CN", exchange: "SZ", code: "123" }),
		(error) => error instanceof DynamicQuoteError && error.code === "INVALID_IDENTITY",
	);
	assert.throws(
		() => canonicalizeIdentity({ market: "CN", exchange: "BJ", code: "430047" }),
		(error) => error instanceof DynamicQuoteError && error.code === "UNSUPPORTED_EXCHANGE",
	);
});

test("Tencent HTTP adapter parses CN and HK records through a synthetic fetch", async () => {
	const cnBody = tencentPayload("sh600000", { code: "600000", name: "Demo CN" });
	const hkBody = tencentPayload("hk00700", {
		market: "HK",
		code: "00700",
		name: "Demo HK",
		amount: "12345",
	});
	assert.equal(parseTencentQuoteResponse("sh600000", cnBody, NOW).amount, 1000);
	assert.equal(parseTencentQuoteResponse("hk00700", hkBody, NOW).amount, 12345);

	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url);
		return new Response(url.endsWith("hk00700") ? hkBody : cnBody, { status: 200 });
	};
	const provider = createTencentQuoteProvider({
		fetchImpl,
		now: NOW,
		endpoint: "https://quotes.test/q=",
	});
	const batch = await fetchDynamicQuoteRows(
		[
			{ market: "CN", exchange: "SH", code: "600000" },
			{ market: "HK", exchange: "HK", code: "00700" },
		],
		{ fetchQuote: provider, now: NOW },
	);
	assert.deepEqual(requested, [
		"https://quotes.test/q=sh600000",
		"https://quotes.test/q=hk00700",
	]);
	assert.deepEqual(
		batch.rows.map((row) => row.code),
		["600000", "00700"],
	);
	assert.equal(batch.rows[1].amount, 12345);
});

test("Tencent HTTP adapter decodes GBK-family mainland names and CN turnover", async () => {
	const [prefix, suffix] = tencentPayload("sh600000", {
		code: "600000",
		name: "NAME_PLACEHOLDER",
		amount: "604625882",
	}).split("NAME_PLACEHOLDER");
	const asciiPrefix = new TextEncoder().encode(prefix);
	// GB18030 bytes for \"浦发银行\" captured from the Tencent CN quote payload.
	const gbkName = Uint8Array.from([0xc6, 0xd6, 0xb7, 0xa2, 0xd2, 0xf8, 0xd0, 0xd0]);
	const asciiSuffix = new TextEncoder().encode(suffix);
	const bytes = new Uint8Array(asciiPrefix.length + gbkName.length + asciiSuffix.length);
	bytes.set(asciiPrefix);
	bytes.set(gbkName, asciiPrefix.length);
	bytes.set(asciiSuffix, asciiPrefix.length + gbkName.length);
	const quote = await fetchTencentQuote("sh600000", {
		fetchImpl: async () => new Response(bytes, { status: 200 }),
		now: NOW,
	});
	assert.equal(quote.name, "浦发银行");
	assert.equal(quote.amount, 604625882);
});

test("market status follows the current Shanghai session instead of Tencent record type", () => {
	const payload = tencentPayload("sz000001", { code: "000001", quoteTime: "20260914095900" });
	const open = parseTencentQuoteResponse(
		"sz000001",
		payload,
		new Date("2026-09-14T10:00:00+08:00"),
	);
	const lunch = parseTencentQuoteResponse(
		"sz000001",
		payload,
		new Date("2026-09-14T12:00:00+08:00"),
	);
	assert.equal(open.market_status, "OPEN");
	assert.equal(lunch.market_status, "CLOSED");
});

test("Tencent HTTP failures remain structured", async () => {
	await assert.rejects(
		() =>
			fetchTencentQuote("sz000001", {
				fetchImpl: async () => new Response("", { status: 503 }),
				now: NOW,
			}),
		(error) =>
			error instanceof DynamicQuoteError &&
			error.code === "PROVIDER_UNAVAILABLE" &&
			error.failures[0].symbol === "sz000001",
	);
});

test("provider unavailable is structured and never returns an empty success", async () => {
	await assert.rejects(
		() =>
			fetchDynamicQuoteRows([{ market: "CN", exchange: "SH", code: "600000" }], {
				fetchQuote: async () => {
					throw new Error("network down");
				},
				now: NOW,
			}),
		(error) => {
			assert.ok(error instanceof DynamicQuoteError);
			assert.equal(error.code, "PROVIDER_UNAVAILABLE");
			assert.equal(error.failures.length, 1);
			assert.equal(error.failures[0].symbol, "sh600000");
			return true;
		},
	);
});

test("partial provider failure returns the complete failure collection and no mergeable rows", async () => {
	const identities = [
		{ market: "CN", exchange: "SH", code: "600000" },
		{ market: "CN", exchange: "SZ", code: "000001" },
		{ market: "HK", exchange: "HK", code: "00700" },
	];
	await assert.rejects(
		() =>
			fetchDynamicQuoteRows(identities, {
				fetchQuote: async (_symbol, identity) => {
					if (identity.code === "000001") throw new Error("one request failed");
					return providerQuote(identity.code);
				},
				now: NOW,
			}),
		(error) => {
			assert.ok(error instanceof DynamicQuoteError);
			assert.equal(error.code, "PARTIAL_PROVIDER_FAILURE");
			assert.deepEqual(
				error.failures.map((failure) => failure.identity.code),
				["000001"],
			);
			assert.equal(error.rows.length, 0);
			return true;
		},
	);
});

test("full active universe fetch resolves SH/SZ/HK and creates normalized unclassified LIVE rows", async () => {
	const identities = [
		{ market: "CN", exchange: "SH", code: "600000" },
		{ market: "CN", exchange: "SZ", code: "000001" },
		{ market: "HK", exchange: "HK", code: "00700" },
	];
	const requestedSymbols = [];
	const batch = await fetchDynamicQuoteRows(identities, {
		fetchQuote: async (symbol, identity) => {
			requestedSymbols.push(symbol);
			return providerQuote(`Name ${identity.code}`);
		},
		now: NOW,
	});

	assert.deepEqual(requestedSymbols, ["sh600000", "sz000001", "hk00700"]);
	assert.deepEqual(
		batch.rows.map((row) => `${row.market}:${row.exchange}:${row.code}`),
		["CN:SH:600000", "CN:SZ:000001", "HK:HK:00700"],
	);
	for (const row of batch.rows) {
		assert.equal(row.group, "Watch");
		assert.equal(row.portfolio_group, "watch");
		assert.equal(row.portfolio_status, "WATCH");
		assert.equal(row.holding_status, "ACTIVE");
		assert.equal(row.is_position, true);
		assert.equal(row.mapping_only, false);
	}
});

test("merge appends only missing active rows, preserves the snapshot, and remains validation-compatible", async () => {
	const originalStock = existingStock();
	const snapshot = snapshotOf([originalStock]);
	const identities = [
		{ market: "CN", exchange: "SH", code: "600000" },
		{ market: "CN", exchange: "SZ", code: "000001" },
		{ market: "HK", exchange: "HK", code: "00700" },
	];
	const batch = await fetchDynamicQuoteRows(identities, {
		fetchQuote: async (_symbol, identity) => providerQuote(`Name ${identity.code}`),
		now: NOW,
	});
	const merged = mergeDynamicQuoteRows(snapshot, batch);

	assert.deepEqual(
		snapshot.stocks.map((row) => row.code),
		["600000"],
	);
	assert.deepEqual(
		merged.stocks.map((row) => row.code),
		["600000", "000001", "00700"],
	);
	assert.equal(merged.summary.total, 3);
	assert.equal(merged.summary.active_quote_total, 3);
	assert.equal(merged.summary.active_holding_total, 3);
	assert.equal(merged.summary.watch_total, 2);
	assert.equal(merged.stocks.find((row) => row.code === "000001")?.group, "Watch");
	assert.equal(merged.portfolio_universe.length, 3);
	assert.doesNotThrow(() => validateSnapshot(merged));
});
