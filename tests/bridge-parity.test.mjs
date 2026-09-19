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

const { updateQuoteBridge } = await import("../src/index.ts");
const { runManualQuoteBridge } = await import("../scripts/manual-quote-bridge.mjs");
const { toPublicQuoteSnapshot } = await import("../src/quote-projections.ts");
const { quoteCatalogFromSnapshot, writeQuoteCatalog } = await import("../src/quote-catalog.ts");

function dynamicSnapshot() {
	const row = {
		code: "002409",
		market: "CN",
		exchange: "SZ",
		name: "Dynamic security",
		group: "Watch",
		portfolio_group: "watch",
		portfolio_status: "WATCH",
		holding_status: "ACTIVE",
		mapping_only: false,
		mapped_to: null,
		mapping_to: null,
		position_qty: null,
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
		quality: "SYNTHETIC",
	};
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
		portfolio_version: "live:dynamic-002409",
		snapshot_time: "2026-09-13T15:01:00+08:00",
		system_quality: "GOOD",
		summary: { total: 1 },
		portfolio_universe: [identity],
		stocks: [row],
	};
}

function response(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function tencentRecord(symbol, code) {
	const fields = Array.from({ length: 40 }, () => "");
	fields[0] = "1";
	fields[1] = "Dynamic security";
	fields[2] = code;
	fields[3] = "10";
	fields[4] = "9";
	fields[5] = "9.5";
	fields[6] = "100";
	fields[30] = "20260913150000";
	fields[31] = "1";
	fields[32] = "11.11";
	fields[33] = "10.5";
	fields[34] = "9";
	fields[35] = "10/100/1000";
	return `v_${symbol}="${fields.join("~")}";`;
}

function memoryKv() {
	const values = new Map();
	return {
		get: async (key) => values.get(key) ?? null,
		put: async (key, value) => values.set(key, value),
	};
}

test("Cron and manual rerun accept the same dynamically added legal security", async () => {
	// 双契约（issue #7）：cron 消费旧 origin 的富快照并投影 quote-only；
	// manual 直接消费新 Worker 的公开 quote-only 路由（已投影）。两者必须收敛到同一 schema。
	const snapshot = dynamicSnapshot();
	const publicSnapshot = toPublicQuoteSnapshot(snapshot);
	const kv = memoryKv();
	await writeQuoteCatalog(kv, quoteCatalogFromSnapshot(snapshot));
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, options = {}) => {
		const url = String(input);
		if (url === "https://api.github.com/repos/zhushihao/quantpro-collector/issues/1") {
			return response(options.method === "PATCH" ? {} : { body: "" });
		}
		if (url.includes("qt.gtimg.cn/q=sz002409")) {
			return new Response(tencentRecord("sz002409", "002409"), { status: 200 });
		}
		return new Response("", { status: 503 });
	};
	let cronPayload;
	try {
		cronPayload = await updateQuoteBridge(
			{ GITHUB_TOKEN: "test-token", PORTFOLIO_UNIVERSE: kv },
			"cron:dynamic-parity",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}

	let updated = null;
	const manual = await runManualQuoteBridge({
		env: { ISSUE_NUMBER: "1" },
		sources: ["https://quotes.example/portfolio"],
		github: {
			getIssue: async () => ({ data: { body: "" } }),
			updateIssue: async (_number, update) => {
				updated = update;
			},
		},
		fetchImpl: async () => response(publicSnapshot),
		now: "2026-09-13T07:00:00.000Z",
	});

	assert.equal(cronPayload.bridge.last_attempt_status, "SUCCESS");
	assert.equal(manual.payload.bridge.last_attempt_status, "SUCCESS");
	assert.equal(cronPayload.snapshot.schema_version, "public_quote_snapshot/1");
	assert.equal(manual.payload.snapshot.schema_version, "public_quote_snapshot/1");
	assert.deepEqual(
		cronPayload.snapshot.stocks.map((row) => row.code),
		manual.payload.snapshot.stocks.map((row) => row.code),
	);
	assert.equal(Object.hasOwn(cronPayload.snapshot.stocks[0], "is_position"), false);
	assert.equal(Object.hasOwn(manual.payload.snapshot.stocks[0], "is_position"), false);
	assert.match(updated.body, /002409/);
});
