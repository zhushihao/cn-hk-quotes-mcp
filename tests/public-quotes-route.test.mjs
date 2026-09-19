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

const { default: worker } = await import("../src/index.ts");

function stock(
	code,
	market = "CN",
	exchange = "SZ",
	portfolioGroup = "core",
	portfolioStatus = "CORE",
	holdingStatus = "ACTIVE",
	isPosition = true,
	mappingOnly = false,
) {
	return {
		market, exchange, code, name: `Name ${code}`,
		group: portfolioGroup === "growth" ? "Growth" : portfolioGroup === "watch" ? "Watch" : "Core",
		portfolio_group: portfolioGroup, portfolio_status: portfolioStatus,
		holding_status: holdingStatus, mapping_only: mappingOnly,
		mapped_to: mappingOnly ? "300308.SZ" : null,
		mapping_to: mappingOnly ? "300308.SZ" : null,
		position_qty: isPosition ? 100 : 0, is_position: isPosition,
		price: 10, change: 1, change_pct: 10, pre_close: 9, prev_close: 9,
		open: 9.5, high: 10.5, low: 9, pct_change: 10, volume: 100, amount: 1000,
		market_status: "CLOSED", market_data_time: "2026-09-18T15:00:00+08:00",
		source_update_time: "2026-09-18T15:01:00+08:00", freshness_basis: "MARKET_DATA",
		quote_time: "2026-09-18T15:00:00+08:00", fetch_time: "2026-09-19T00:00:00Z",
		age_seconds: 60, primary_source: "tencent", secondary_source: null,
		source_status: "OK", quality: "CLOSED_SNAPSHOT",
	};
}

function snapshot() {
	const stocks = [
		stock("300308"),
		stock("300502", "CN", "SZ", "growth", "GROWTH", "WATCH", false),
		stock("301183", "CN", "SZ", "watch", "WATCH", "WATCH", false),
	];
	return {
		portfolio_version: "catalog-v1",
		snapshot_time: "2026-09-18T15:01:00+08:00",
		market_status: "CLOSED",
		source_mode: "MULTI_SOURCE",
		system_quality: "OK",
		summary: { total: stocks.length, usable: stocks.length },
		portfolio_universe: stocks.map((row) => ({
			market: row.market, exchange: row.exchange, code: row.code, name: row.name,
			group: row.group, portfolio_group: row.portfolio_group,
			portfolio_status: row.portfolio_status, holding_status: row.holding_status,
			mapping_only: row.mapping_only, mapped_to: row.mapped_to, mapping_to: row.mapping_to,
			position_qty: row.position_qty, is_position: row.is_position,
		})),
		stocks,
	};
}

function privateCatalog() {
	const source = snapshot();
	return {
		schema_version: "quote-catalog/1",
		generated_at: "2026-09-19T00:00:00Z",
		source_catalog_version: source.portfolio_version,
		items: source.stocks.map((row) => ({
			market: row.market, exchange: row.exchange, code: row.code, name: row.name,
			group: row.group, portfolio_group: row.portfolio_group,
			portfolio_status: row.portfolio_status, mapping_only: row.mapping_only,
			mapped_to: row.mapped_to, mapping_to: row.mapping_to,
		})),
	};
}

function memoryKv(seedCatalog = true) {
	const values = new Map();
	if (seedCatalog) values.set("quote-catalog/current", JSON.stringify(privateCatalog()));
	return {
		get: async (key) => values.get(key) ?? null,
		put: async (key, value) => values.set(key, value),
		values,
	};
}

function envWithKv(seedCatalog = true) {
	return {
		GITHUB_TOKEN: "test-token",
		PORTFOLIO_UNIVERSE_TOKEN: "private-token",
		CF_ACCESS_CLIENT_ID: "test-access-id",
		CF_ACCESS_CLIENT_SECRET: "test-access-secret",
		PORTFOLIO_UNIVERSE: memoryKv(seedCatalog),
	};
}

function context() {
	return { waitUntil() {}, passThroughOnException() {} };
}

function tencentRecord(symbol, code, market) {
	const fields = Array.from({ length: 40 }, () => "");
	fields[0] = "1";
	fields[1] = `Quote ${code}`;
	fields[2] = code;
	fields[3] = "10";
	fields[4] = "9";
	fields[5] = "9.5";
	fields[6] = "100";
	fields[30] = "20260918150000";
	fields[31] = "1";
	fields[32] = "11.11";
	fields[33] = "10.5";
	fields[34] = "9";
	fields[35] = "10/100/1000";
	fields[37] = market === "HK" ? "1000" : "";
	return `v_${symbol}="${fields.join("~")}";`;
}

function directProvider(counter, status = 200) {
	return async (input) => {
		counter.count += 1;
		const url = String(input);
		assert.match(url, /^https:\/\/qt\.gtimg\.cn\/q=/);
		const symbol = decodeURIComponent(url.split("q=")[1] ?? "");
		const code = symbol.slice(2);
		return new Response(tencentRecord(symbol, code, symbol.startsWith("hk") ? "HK" : "CN"), { status });
	};
}

async function fetchPublicRoute(fetchImpl, env = envWithKv()) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await worker.fetch(new Request("https://worker.example/api/public/quotes"), env, context());
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function callPublicTool(fetchImpl, env = envWithKv()) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await worker.fetch(
			new Request("https://worker.example/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_public_quotes", arguments: {} } }),
			}),
			env,
			context(),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function readMcpJson(response) {
	const text = await response.text();
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		const data = text.match(/^data: (.+)$/m)?.[1];
		assert.ok(data, text);
		return JSON.parse(data);
	}
	return JSON.parse(text);
}

test("public route returns quote-only output from private catalog + direct provider", async () => {
	const counter = { count: 0 };
	const response = await fetchPublicRoute(directProvider(counter));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.schema_version, "public_quote_snapshot/1");
	assert.equal(body.summary.total, 3);
	assert.equal(Object.hasOwn(body, "portfolio_universe"), false);
	assert.equal(Object.hasOwn(body.stocks[0], "is_position"), false);
	assert.equal(Object.hasOwn(body.stocks[0], "portfolio_group"), false);
	assert.equal(counter.count, 3);
});

test("public MCP tool uses the same quote-only shape", async () => {
	const counter = { count: 0 };
	const response = await callPublicTool(directProvider(counter));
	assert.equal(response.status, 200);
	const payload = await readMcpJson(response);
	const content = payload.result?.content?.find((item) => item.type === "text");
	assert.ok(content, JSON.stringify(payload));
	const body = JSON.parse(content.text);
	assert.equal(body.schema_version, "public_quote_snapshot/1");
	assert.equal(Object.hasOwn(body.stocks[0], "position_qty"), false);
});

test("phase-1 seed reads protected legacy source once and stores privacy-safe catalog", async () => {
	const env = envWithKv(false);
	let legacyCalls = 0;
	let directCalls = 0;
	const response = await fetchPublicRoute(async (input) => {
		const url = String(input);
		if (url.startsWith("https://cn-hk-quotes-proxy.zhushihao710.workers.dev/")) {
			legacyCalls += 1;
			return new Response(JSON.stringify(snapshot()), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		directCalls += 1;
		const symbol = decodeURIComponent(url.split("q=")[1] ?? "");
		return new Response(tencentRecord(symbol, symbol.slice(2), symbol.startsWith("hk") ? "HK" : "CN"), { status: 200 });
	}, env);
	assert.equal(response.status, 200);
	assert.equal(legacyCalls, 1);
	assert.equal(directCalls, 3);
	const stored = JSON.parse(env.PORTFOLIO_UNIVERSE.values.get("quote-catalog/current"));
	assert.equal(Object.hasOwn(stored.items[0], "holding_status"), false);
	assert.equal(Object.hasOwn(stored.items[0], "position_qty"), false);
	assert.equal(Object.hasOwn(stored.items[0], "is_position"), false);
});

test("direct provider failure is a closed public 502", async () => {
	const counter = { count: 0 };
	const response = await fetchPublicRoute(directProvider(counter, 500));
	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), {
		error: "UPSTREAM_UNAVAILABLE",
		message: "Public quote snapshot is unavailable",
	});
	assert.ok(counter.count > 0);
});

test("invalid direct-provider payload is a closed public 502", async () => {
	const response = await fetchPublicRoute(async () => new Response("not-a-tencent-record", { status: 200 }));
	assert.equal(response.status, 502);
});

test("public route only accepts GET", async () => {
	const response = await worker.fetch(
		new Request("https://worker.example/api/public/quotes", { method: "POST" }),
		envWithKv(),
		context(),
	);
	assert.equal(response.status, 405);
});
