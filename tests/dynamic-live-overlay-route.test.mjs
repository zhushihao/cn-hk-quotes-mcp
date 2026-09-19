import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Let Node resolve non-TypeScript imports normally.
			}
		}
		return nextResolve(specifier, context);
	},
});

const { default: worker } = await import("../src/index.ts");
const { computeLiveUniverseHash, writeLiveUniverse } = await import("../src/live-universe.ts");
const { writePortfolioStatus } = await import("../src/portfolio-status.ts");
const { readPortfolioUniverseDelta } = await import("../src/portfolio-delta.ts");
const { quoteCatalogFromSnapshot, writeQuoteCatalog } = await import("../src/quote-catalog.ts");

const MANIFEST_HASH = `sha256:${"b".repeat(64)}`;

function stock(code = "300308") {
	return {
		code,
		market: "CN",
		exchange: "SZ",
		name: `Catalog ${code}`,
		group: "Core",
		portfolio_group: "core",
		portfolio_status: "CORE",
		holding_status: "ACTIVE",
		mapping_only: false,
		mapped_to: null,
		mapping_to: null,
		position_qty: 100,
		is_position: true,
		price: 10,
		change: 1,
		change_pct: 10,
		pre_close: 9,
		prev_close: 9,
		open: 9.5,
		high: 10.5,
		low: 9,
		pct_change: 10,
		volume: 100,
		amount: 1000,
		market_status: "CLOSED",
		market_data_time: "2026-09-13T15:00:00+08:00",
		source_update_time: "2026-09-13T15:01:00+08:00",
		freshness_basis: "MARKET_DATA",
		quote_time: "2026-09-13T15:00:00+08:00",
		fetch_time: "2026-09-13T15:01:00+08:00",
		age_seconds: 60,
		primary_source: "synthetic",
		secondary_source: null,
		source_status: "OK",
		quality: "CLOSED_SNAPSHOT",
	};
}

function catalog() {
	const row = stock();
	const {
		price,
		change,
		change_pct,
		pre_close,
		prev_close,
		open,
		high,
		low,
		pct_change,
		volume,
		amount,
		market_status,
		market_data_time,
		source_update_time,
		freshness_basis,
		quote_time,
		fetch_time,
		age_seconds,
		primary_source,
		secondary_source,
		source_status,
		quality,
		...identity
	} = row;
	return {
		portfolio_version: "catalog-v1",
		snapshot_time: "2026-09-13T15:01:00+08:00",
		system_quality: "OK",
		summary: { total: 1 },
		portfolio_universe: [identity],
		stocks: [row],
	};
}

function tencentRecord(symbol, code) {
	const fields = Array.from({ length: 40 }, () => "");
	fields[0] = "1";
	fields[1] = `LIVE ${code}`;
	fields[2] = code;
	fields[3] = "10";
	fields[4] = "9";
	fields[5] = "9.5";
	fields[6] = "100";
	fields[8] = "0";
	fields[35] = "10/100/1000";
	fields[30] = "20260913095900";
	fields[31] = "1";
	fields[32] = "11.1111";
	fields[33] = "10.5";
	fields[34] = "9";
	return `v_${symbol}="${fields.join("~")}";`;
}

function memoryKv() {
	const values = new Map();
	return {
		get: async (key) => values.get(key) ?? null,
		put: async (key, value) => {
			values.set(key, value);
		},
	};
}

async function liveEnv(active) {
	const kv = memoryKv();
	await writeQuoteCatalog(kv, quoteCatalogFromSnapshot(catalog()));
	const contentHash = await computeLiveUniverseHash(active);
	const now = new Date().toISOString();
	await writeLiveUniverse(kv, {
		schema_version: "quote-universe/1",
		generated_at: now,
		source_manifest_hash: MANIFEST_HASH,
		active,
		content_hash: contentHash,
	});
	await writePortfolioStatus(kv, {
		schema_version: "portfolio-status/1",
		generated_at: now,
		state: "LIVE_COMPLETE",
		last_real_complete_confirmed_at: now,
		universe_content_hash: contentHash,
		source_manifest_hash: MANIFEST_HASH,
	});
	return { GITHUB_TOKEN: "unused", PORTFOLIO_UNIVERSE_TOKEN: "private", PORTFOLIO_UNIVERSE: kv };
}

function context() {
	return { waitUntil() {}, passThroughOnException() {} };
}

async function privateDynamicRequest(env, fetchImpl) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await worker.fetch(
			new Request("https://collector.example/api/portfolio-quotes", {
				headers: { Authorization: "Bearer private" },
			}),
			env,
			context(),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function pushPortfolioStatus(env, payload) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		if (String(input) === "https://api.github.com/user") {
			return new Response(JSON.stringify({ login: "zhushihao" }), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				full_name: "zhushihao/quantpro-qmt",
				private: true,
				permissions: { push: true },
			}),
			{ status: 200 },
		);
	};
	try {
		return await worker.fetch(
			new Request("https://collector.example/api/github-auth/portfolio-status", {
				method: "POST",
				headers: { Authorization: "Bearer live-token" },
				body: JSON.stringify(payload),
			}),
			env,
			context(),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function writeCompleteUniverse(kv, active, generatedAt = new Date().toISOString()) {
	const contentHash = await computeLiveUniverseHash(active);
	await writeLiveUniverse(kv, {
		schema_version: "quote-universe/1",
		generated_at: generatedAt,
		source_manifest_hash: MANIFEST_HASH,
		active,
		content_hash: contentHash,
	});
	return { contentHash, generatedAt };
}

test("Issue #8 external market:read credential cannot unlock internal universe endpoints", async () => {
	const env = await liveEnv([{ market: "CN", exchange: "SZ", code: "002409" }]);
	env.COLLECTOR_MCP_CLIENT_TOKEN = "external-client";
	env.COLLECTOR_MCP_CLIENT_ID = "chatgpt-production";
	env.COLLECTOR_MCP_CLIENT_SCOPES = "market:read";

	for (const pathname of ["/api/quote-universe", "/api/portfolio-quotes"]) {
		const response = await worker.fetch(
			new Request(`https://collector.example${pathname}`, {
				headers: { Authorization: "Bearer external-client" },
			}),
			env,
			context(),
		);
		assert.equal(response.status, 401, `${pathname} must keep the internal-token boundary`);
		assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
	}
});

test("new legal LIVE identity is fetched dynamically then passes the unchanged coverage gate", async () => {
	const env = await liveEnv([{ market: "CN", exchange: "SZ", code: "002409" }]);
	const response = await privateDynamicRequest(env, async (input) => {
		const url = String(input);
		if (url.includes("qt.gtimg.cn/q=sz300308")) {
			return new Response(tencentRecord("sz300308", "300308"), { status: 200 });
		}
		if (url.includes("qt.gtimg.cn/q=sz002409")) {
			return new Response(tencentRecord("sz002409", "002409"), { status: 200 });
		}
		return new Response("", { status: 503 });
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(
		body.stocks.map((row) => `${row.market}:${row.code}`),
		["CN:002409"],
	);
	assert.equal(body.stocks[0].name, "LIVE 002409");
});

test("dynamic provider failure remains fail-closed and exposes no identity", async () => {
	const env = await liveEnv([{ market: "CN", exchange: "SZ", code: "002409" }]);
	const response = await privateDynamicRequest(env, async (input) => {
		if (String(input).includes("qt.gtimg.cn/")) return new Response("", { status: 503 });
		return new Response(JSON.stringify(catalog()), { status: 200 });
	});
	assert.equal(response.status, 502);
	const body = await response.json();
	assert.equal(body.error, "PORTFOLIO_QUOTES_UNAVAILABLE");
	assert.equal(body.message, "PROVIDER_UNAVAILABLE");
	assert.doesNotMatch(JSON.stringify(body), /002409/);
});

test("partial dynamic provider failure never returns a partial active universe", async () => {
	const env = await liveEnv([
		{ market: "CN", exchange: "SZ", code: "002409" },
		{ market: "CN", exchange: "SZ", code: "002975" },
	]);
	const response = await privateDynamicRequest(env, async (input) => {
		const url = String(input);
		if (url.includes("qt.gtimg.cn/q=sz300308")) {
			return new Response(tencentRecord("sz300308", "300308"), { status: 200 });
		}
		if (url.includes("qt.gtimg.cn/q=sz002409")) {
			return new Response(tencentRecord("sz002409", "002409"), { status: 200 });
		}
		if (url.includes("qt.gtimg.cn/q=sz002975")) return new Response("", { status: 503 });
		return new Response("", { status: 503 });
	});
	assert.equal(response.status, 502);
	const body = await response.json();
	assert.equal(body.message, "PARTIAL_PROVIDER_FAILURE");
	assert.doesNotMatch(JSON.stringify(body), /002409|002975/);
});

test("authenticated LIVE_COMPLETE status pushes emit only the private code-only delta", async () => {
	const kv = memoryKv();
	const env = {
		GITHUB_TOKEN: "unused",
		PORTFOLIO_UNIVERSE_TOKEN: "private",
		PORTFOLIO_UNIVERSE: kv,
	};
	const first = await writeCompleteUniverse(kv, [
		{ market: "CN", exchange: "SZ", code: "002409" },
	]);
	const firstResponse = await pushPortfolioStatus(env, {
		schema_version: "portfolio-status/1",
		generated_at: first.generatedAt,
		state: "LIVE_COMPLETE",
		last_real_complete_confirmed_at: first.generatedAt,
		universe_content_hash: first.contentHash,
		source_manifest_hash: MANIFEST_HASH,
	});
	assert.equal(firstResponse.status, 200);

	const second = await writeCompleteUniverse(
		kv,
		[{ market: "CN", exchange: "SZ", code: "002975" }],
		new Date(Date.parse(first.generatedAt) + 1_000).toISOString(),
	);
	const secondResponse = await pushPortfolioStatus(env, {
		schema_version: "portfolio-status/1",
		generated_at: second.generatedAt,
		state: "LIVE_COMPLETE",
		last_real_complete_confirmed_at: second.generatedAt,
		universe_content_hash: second.contentHash,
		source_manifest_hash: MANIFEST_HASH,
	});
	assert.equal(secondResponse.status, 200);
	assert.deepEqual(await readPortfolioUniverseDelta(kv), {
		previous_complete_hash: first.contentHash,
		current_complete_hash: second.contentHash,
		added_codes: ["CN:002975"],
		removed_codes: ["CN:002409"],
		observed_at: second.generatedAt,
	});
});

test("a declared LIVE_COMPLETE with an expired LRCCA never confirms a portfolio removal", async () => {
	const kv = memoryKv();
	const env = {
		GITHUB_TOKEN: "unused",
		PORTFOLIO_UNIVERSE_TOKEN: "private",
		PORTFOLIO_UNIVERSE: kv,
	};
	const first = await writeCompleteUniverse(kv, [
		{ market: "CN", exchange: "SZ", code: "002409" },
	]);
	assert.equal(
		(
			await pushPortfolioStatus(env, {
				schema_version: "portfolio-status/1",
				generated_at: first.generatedAt,
				state: "LIVE_COMPLETE",
				last_real_complete_confirmed_at: first.generatedAt,
				universe_content_hash: first.contentHash,
				source_manifest_hash: MANIFEST_HASH,
			})
		).status,
		200,
	);

	const second = await writeCompleteUniverse(kv, [
		{ market: "CN", exchange: "SZ", code: "002975" },
	]);
	const staleLrcca = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
	const response = await pushPortfolioStatus(env, {
		schema_version: "portfolio-status/1",
		generated_at: second.generatedAt,
		state: "LIVE_COMPLETE",
		last_real_complete_confirmed_at: staleLrcca,
		universe_content_hash: second.contentHash,
		source_manifest_hash: MANIFEST_HASH,
	});
	assert.equal(response.status, 200);
	assert.equal(await readPortfolioUniverseDelta(kv), null);
});
