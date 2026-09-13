import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	createIssueBody,
	runManualQuoteBridge,
	validateFetchedSnapshot,
} from "../scripts/manual-quote-bridge.mjs";

function makeSnapshot(code = "000001") {
	const stock = {
		code,
		market: "CN",
		exchange: "SZ",
		name: `dynamic-${code}`,
		group: "Core",
		portfolio_group: "core",
		portfolio_status: "CORE",
		holding_status: "ACTIVE",
		mapping_only: false,
		mapped_to: null,
		mapping_to: null,
		position_qty: 1,
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
		source_status: "SUCCESS",
		quality: "SYNTHETIC",
	};
	return {
		portfolio_version: `live:dynamic-${code}`,
		snapshot_time: "2026-09-13T15:01:00+08:00",
		system_quality: "GOOD",
		summary: { total: 1 },
		portfolio_universe: [{ ...stock }],
		stocks: [stock],
	};
}

function fakeGithub(body = "") {
	let updated = null;
	return {
		client: {
			getIssue: async () => ({ data: { body } }),
			updateIssue: async (issueNumber, update) => {
				updated = { issueNumber, ...update };
			},
		},
		get updated() {
			return updated;
		},
	};
}

function response(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
	};
}

test("manual bridge accepts a newly introduced legal security through the shared validator", async () => {
	const snapshot = makeSnapshot("002409");
	const requested = [];
	const result = await runManualQuoteBridge({
		env: {
			SOURCE_URL: "https://primary.example/quotes",
			FALLBACK_SOURCE_URL: "",
			ISSUE_NUMBER: "1",
			GITHUB_RUN_ID: "synthetic-run",
			GITHUB_TOKEN: "synthetic-token",
			GITHUB_REPOSITORY: "owner/repo",
			GITHUB_API_URL: "https://api.example",
		},
		fetchImpl: async (url, options = {}) => {
			requested.push({ url, options });
			if (url === "https://api.example/repos/owner/repo/issues/1") {
				return options.method === "GET"
					? response(200, JSON.stringify({ body: "" }))
					: response(200, JSON.stringify({}));
			}
			return response(200, JSON.stringify(snapshot));
		},
		clock: () => 1_757_737_200_000,
		now: "2026-09-13T07:00:00.000Z",
	});

	assert.equal(result.fetchError, null);
	assert.equal(result.payload.bridge.last_attempt_status, "SUCCESS");
	assert.equal(result.payload.snapshot.stocks[0].code, "002409");
	assert.equal(result.counts.total, 1);
	assert.equal(requested.length, 3);
	assert.equal(requested[0].options.headers.Authorization, "Bearer synthetic-token");
	assert.equal(requested[2].options.method, "PATCH");
	assert.match(JSON.parse(requested[2].options.body).body, /QuantPro Collector/);
});

test("manual bridge keeps the existing 404 fallback behavior", async () => {
	const snapshot = makeSnapshot("600001");
	const github = fakeGithub();
	const requested = [];
	const result = await runManualQuoteBridge({
		env: { ISSUE_NUMBER: "1" },
		sources: ["https://primary.example/quotes", "https://fallback.example/quotes"],
		github: github.client,
		fetchImpl: async (url) => {
			requested.push(url);
			return requested.length === 1
				? response(404, "not found")
				: response(200, JSON.stringify(snapshot));
		},
		now: "2026-09-13T07:00:00.000Z",
	});

	assert.equal(result.fetchError, null);
	assert.equal(result.usedSource, "https://fallback.example/quotes");
	assert.equal(requested.length, 2);
});

test("failed manual fetch updates Issue with the previous successful snapshot", async () => {
	const previousSnapshot = makeSnapshot("300001");
	const previousPayload = {
		schema_version: "1.0",
		bridge: { last_success_at: "2026-09-12T07:00:00.000Z" },
		snapshot: previousSnapshot,
	};
	const github = fakeGithub(createIssueBody(previousPayload));
	const result = await runManualQuoteBridge({
		env: { ISSUE_NUMBER: "1" },
		sources: ["https://primary.example/quotes"],
		github: github.client,
		fetchImpl: async () => response(503, "temporarily unavailable"),
		now: "2026-09-13T07:00:00.000Z",
	});

	assert.match(result.fetchError, /HTTP 503/);
	assert.equal(result.payload.bridge.last_attempt_status, "FAIL");
	assert.equal(result.payload.bridge.last_success_at, "2026-09-12T07:00:00.000Z");
	assert.deepEqual(result.payload.snapshot, previousSnapshot);
	assert.match(github.updated.body, /temporarily unavailable/);
});

test("manual and Worker/Cron paths point to the same production validator", () => {
	const manualSource = readFileSync(
		new URL("../scripts/manual-quote-bridge.mjs", import.meta.url),
		"utf8",
	);
	const workerSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const workflowSource = readFileSync(
		new URL("../.github/workflows/update-quote-bridge.yml", import.meta.url),
		"utf8",
	);

	assert.match(manualSource, /from ["']\.\.\/src\/portfolio-validation\.ts["']/);
	assert.match(workerSource, /from ["']\.\/portfolio-validation["']/);
	assert.match(workerSource, /validateSnapshot\(snapshot\)/);
	assert.match(workflowSource, /actions\/checkout@v4/);
	assert.match(
		workflowSource,
		/node --experimental-strip-types scripts\/manual-quote-bridge\.mjs/,
	);
	assert.doesNotMatch(workflowSource, /actions\/github-script/);
	assert.doesNotMatch(
		workflowSource,
		/2026-09-01-v4|expectedKeys|requiredWatchKeys|CN:\d{5,6}|HK:\d{5,6}/,
	);
	assert.doesNotMatch(workflowSource, /npm\s+(ci|install)/);
	assert.doesNotThrow(() => validateFetchedSnapshot(makeSnapshot("688001")));
});
