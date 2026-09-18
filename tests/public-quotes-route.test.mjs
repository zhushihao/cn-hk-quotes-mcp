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

const { default: worker } = await import("../src/index.ts");

function stock(code, market = "CN", exchange = "SZ", portfolioGroup = "core", portfolioStatus = "CORE", holdingStatus = "ACTIVE", isPosition = true, mappingOnly = false) {
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

function snapshot() {
	const stocks = [stock("300308"), stock("300502", "CN", "SZ", "growth", "GROWTH", "ACTIVE", true), stock("301183", "CN", "SZ", "watch", "WATCH", "WATCH", false)];
	const portfolioUniverse = stocks.map((stock) => ({
		market: stock.market, exchange: stock.exchange, code: stock.code, name: stock.name,
		group: stock.group, portfolio_group: stock.portfolio_group, portfolio_status: stock.portfolio_status,
		holding_status: stock.holding_status, mapping_only: stock.mapping_only,
		mapped_to: stock.mapped_to, mapping_to: stock.mapping_to,
		position_qty: stock.position_qty, is_position: stock.is_position,
	}));
	return {
		portfolio_version: "catalog-v1", snapshot_time: "2026-09-11T15:01:00+08:00",
		market_status: "CLOSED", source_mode: "MULTI_SOURCE", system_quality: "OK",
		summary: { total: stocks.length, usable: stocks.length, active_holding_total: 2 },
		portfolio_universe: portfolioUniverse,
		stocks,
	};
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function context() {
	return { waitUntil() {}, passThroughOnException() {} };
}

function envWithKv() {
	return {
		GITHUB_TOKEN: "test-token",
		PORTFOLIO_UNIVERSE_TOKEN: "private-token",
		CF_ACCESS_CLIENT_ID: "test-access-id",
		CF_ACCESS_CLIENT_SECRET: "test-access-secret",
		PORTFOLIO_UNIVERSE: {
			get: async () => { throw new Error("public route must not read LIVE KV"); },
		},
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

const PROTECTED_QUOTES_SOURCE = "https://cn-hk-quotes-proxy.zhushihao710.workers.dev/api/portfolio-quotes";

function publicUpstream(fetchCount, status = 200, body = snapshot()) {
	return async (input, options = {}) => {
		fetchCount.count += 1;
		const url = String(input);
		assert.match(url, new RegExp(`${PROTECTED_QUOTES_SOURCE.replaceAll(".", "\\.")}\\?_bridge_ts=`));
		const headers = new Headers(options.headers);
		assert.equal(headers.get("CF-Access-Client-Id"), "test-access-id");
		assert.equal(headers.get("CF-Access-Client-Secret"), "test-access-secret");
		return jsonResponse(body, status);
	};
}

test("public route returns a quote-only snapshot without reading LIVE KV", async () => {
	const fetchCount = { count: 0 };
	const response = await fetchPublicRoute(publicUpstream(fetchCount));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const body = await response.json();
	assert.equal(body.schema_version, "public_quote_snapshot/1");
	assert.equal(body.summary.total, 3);
	assert.equal(Object.hasOwn(body, "portfolio_universe"), false);
	assert.equal(Object.hasOwn(body.stocks[0], "is_position"), false);
	assert.equal(fetchCount.count, 1);
});

test("public MCP tool uses the same quote-only snapshot shape", async () => {
	const fetchCount = { count: 0 };
	const response = await callPublicTool(publicUpstream(fetchCount));
	assert.equal(response.status, 200);
	const payload = await readMcpJson(response);
	const content = payload.result?.content?.find((item) => item.type === "text");
	assert.ok(content, JSON.stringify(payload));
	const body = JSON.parse(content.text);
	assert.equal(body.schema_version, "public_quote_snapshot/1");
	assert.equal(Object.hasOwn(body, "portfolio_universe"), false);
	assert.equal(Object.hasOwn(body.stocks[0], "position_qty"), false);
	assert.equal(fetchCount.count, 1);
});

test("public route returns a closed 502 error and never falls back to private output", async () => {
	const fetchCount = { count: 0 };
	const response = await fetchPublicRoute(async () => {
		fetchCount.count += 1;
		return jsonResponse({ private: "should not be returned" }, 500);
	});
	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), { error: "UPSTREAM_UNAVAILABLE", message: "Public quote snapshot is unavailable" });
	assert.equal(fetchCount.count, 1);
});

test("public route converts a protected-source 404 into the closed public error", async () => {
	const fetchCount = { count: 0 };
	const response = await fetchPublicRoute(publicUpstream(fetchCount, 404, { private: "should not be returned" }));
	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), { error: "UPSTREAM_UNAVAILABLE", message: "Public quote snapshot is unavailable" });
	assert.equal(fetchCount.count, 1);
});

test("public route converts a structurally invalid snapshot into the closed public error", async () => {
	const malformed = snapshot();
	delete malformed.stocks[0].quality;
	const response = await fetchPublicRoute(publicUpstream({ count: 0 }, 200, malformed));
	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), { error: "UPSTREAM_UNAVAILABLE", message: "Public quote snapshot is unavailable" });
});

test("public MCP tool returns a closed error when upstream JSON is invalid", async () => {
	const response = await callPublicTool(async () => new Response("not-json", { status: 200 }));
	assert.equal(response.status, 200);
	const payload = await readMcpJson(response);
	const content = payload.result?.content?.find((item) => item.type === "text");
	assert.ok(content, JSON.stringify(payload));
	assert.equal(payload.result?.isError, true);
	assert.deepEqual(JSON.parse(content.text), { error: "UPSTREAM_UNAVAILABLE", message: "Public quote snapshot is unavailable" });
});

test("public route only accepts GET", async () => {
	const response = await worker.fetch(
		new Request("https://worker.example/api/public/quotes", { method: "POST" }),
		envWithKv(),
		context(),
	);
	assert.equal(response.status, 405);
});
