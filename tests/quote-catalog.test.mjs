import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {}
		}
		return nextResolve(specifier, context);
	},
});

const { quoteCatalogFromSnapshot, fetchQuoteSnapshotFromCatalog } =
	await import("../src/quote-catalog.ts");

function stock(
	code,
	group = "Core",
	portfolioGroup = "core",
	mapping = false,
) {
	return {
		market: code.length === 5 ? "HK" : "CN",
		exchange: code.length === 5 ? "HK" : "SZ",
		code,
		name: `N${code}`,
		group,
		portfolio_group: portfolioGroup,
		portfolio_status:
			mapping ? null : portfolioGroup === "core" ? "CORE" : portfolioGroup === "growth" ? "GROWTH" : "WATCH",
		holding_status: mapping ? "MAPPING_ONLY" : "ACTIVE",
		mapping_only: mapping,
		mapped_to: mapping ? "300308.SZ" : null,
		mapping_to: mapping ? "300308.SZ" : null,
		position_qty: mapping ? 0 : 123,
		is_position: !mapping,
		price: 10,
		change: 1,
		change_pct: 10,
		pre_close: 9,
		prev_close: 9,
		open: 9,
		high: 11,
		low: 8,
		pct_change: 10,
		volume: 100,
		amount: 1000,
		market_status: "CLOSED",
		market_data_time: "2026-09-18T15:00:00+08:00",
		source_update_time: "2026-09-18T15:00:00+08:00",
		freshness_basis: "MARKET_DATA",
		quote_time: "2026-09-18T15:00:00+08:00",
		fetch_time: "2026-09-19T00:00:00Z",
		age_seconds: 36000,
		primary_source: "tencent",
		secondary_source: null,
		source_status: "OK",
		quality: "CLOSED_SNAPSHOT",
	};
}

function snapshot() {
	const stocks = [
		stock("300308"),
		stock("03308", "Core", "mapping", true),
	];
	return {
		portfolio_version: "legacy-v1",
		snapshot_time: "2026-09-18T15:00:00+08:00",
		system_quality: "OK",
		summary: { total: stocks.length },
		portfolio_universe: stocks.map((s) => ({
			code: s.code,
			market: s.market,
			exchange: s.exchange,
			name: s.name,
			group: s.group,
			portfolio_group: s.portfolio_group,
			portfolio_status: s.portfolio_status,
			holding_status: s.holding_status,
			mapping_only: s.mapping_only,
			mapped_to: s.mapped_to,
			mapping_to: s.mapping_to,
			position_qty: s.position_qty,
			is_position: s.is_position,
		})),
		stocks,
	};
}

test("catalog strips runtime holding state by construction", () => {
	const catalog = quoteCatalogFromSnapshot(
		snapshot(),
		new Date("2026-09-19T00:00:00Z"),
	);
	assert.equal(Object.hasOwn(catalog.items[0], "holding_status"), false);
	assert.equal(Object.hasOwn(catalog.items[0], "position_qty"), false);
	assert.equal(Object.hasOwn(catalog.items[0], "is_position"), false);
});

test("direct refresh preserves classification but starts with no holdings", async () => {
	const catalog = quoteCatalogFromSnapshot(
		snapshot(),
		new Date("2026-09-19T00:00:00Z"),
	);
	const refreshed = await fetchQuoteSnapshotFromCatalog(catalog, {
		now: new Date("2026-09-19T01:00:00Z"),
		fetchQuote: (_symbol, identity) => ({
			name: `Q${identity.code}`,
			price: 10,
			pre_close: 9,
			open: 9,
			high: 11,
			low: 8,
			volume: 100,
			amount: 1000,
			market_status: "CLOSED",
			market_data_time: "2026-09-18T15:00:00+08:00",
			source_update_time: "2026-09-18T15:00:00+08:00",
			quote_time: "2026-09-18T15:00:00+08:00",
			fetch_time: "2026-09-19T01:00:00Z",
		}),
	});
	assert.equal(refreshed.stocks[0].portfolio_group, "core");
	assert.equal(refreshed.stocks[0].holding_status, "WATCH");
	assert.equal(refreshed.stocks[0].is_position, false);
	assert.equal(refreshed.stocks[0].position_qty, 0);
	assert.equal(refreshed.stocks[1].holding_status, "MAPPING_ONLY");
});
