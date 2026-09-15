import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const { createD1Kv, createD1OAuthKv } = await import("../src/d1-oauth-kv.ts");

/**
 * In-memory SQLite stand-in for the Collector's private D1 database (issue #17).
 * Values below are synthetic; no credential, deployed Worker, or LIVE payload is involved.
 */
class SqliteD1 {
	constructor() {
		this.sqlite = new DatabaseSync(":memory:");
	}

	prepare(sql) {
		const sqlite = this.sqlite;
		let values = [];
		return {
			bind(...params) {
				values = params;
				return this;
			},
			async run() {
				const result = sqlite.prepare(sql).run(...values);
				return { meta: { changes: Number(result.changes) } };
			},
			async first() {
				return sqlite.prepare(sql).get(...values) ?? null;
			},
			async all() {
				return { results: sqlite.prepare(sql).all(...values) };
			},
		};
	}

	rows(table) {
		return this.sqlite.prepare(`SELECT kv_key, value FROM ${table}`).all();
	}
}

test("portfolio control plane adapter round-trips the universe/status/delta keyspace", async () => {
	const db = new SqliteD1();
	const store = createD1Kv(db, "portfolio_kv_v1");
	await store.put("live-portfolio/current", '{"content_hash":"sha256:aaa"}');
	await store.put("live-portfolio/status", '{"portfolio_state":"LIVE_COMPLETE"}');
	await store.put("live-portfolio/private/complete-baseline-v1", '{"eligible":true}');
	assert.equal(await store.get("live-portfolio/current"), '{"content_hash":"sha256:aaa"}');
	assert.deepEqual(await store.get("live-portfolio/status", { type: "json" }), {
		portfolio_state: "LIVE_COMPLETE",
	});
	const listed = await store.list({ prefix: "live-portfolio/private/" });
	assert.deepEqual(
		listed.keys.map((key) => key.name),
		["live-portfolio/private/complete-baseline-v1"],
	);
	await store.delete("live-portfolio/status");
	assert.equal(await store.get("live-portfolio/status"), null);
});

test("portfolio and OAuth adapters isolate tables inside the same D1 database", async () => {
	const db = new SqliteD1();
	const portfolio = createD1Kv(db, "portfolio_kv_v1");
	const oauth = createD1OAuthKv(db);
	await portfolio.put("live-portfolio/current", "portfolio-row");
	await oauth.put("live-portfolio/current", "oauth-row");
	assert.equal(await portfolio.get("live-portfolio/current"), "portfolio-row");
	assert.equal(await oauth.get("live-portfolio/current"), "oauth-row");
	const tables = db
		.rows("portfolio_kv_v1")
		.map((row) => row.value)
		.sort();
	assert.deepEqual(tables, ["portfolio-row"]);
	assert.deepEqual(db.rows("oauth_kv_v1").map((row) => row.value), ["oauth-row"]);
});

test("expired rows stay invisible to the portfolio adapter reads", async () => {
	const db = new SqliteD1();
	const store = createD1Kv(db, "portfolio_kv_v1");
	await store.put("live-portfolio/status", "stale", { expirationTtl: -60 });
	assert.equal(await store.get("live-portfolio/status"), null);
	const listed = await store.list({ prefix: "live-portfolio/" });
	assert.deepEqual(listed.keys, []);
});

test("adapter rejects table names outside a fixed lowercase identifier pattern", () => {
	const db = new SqliteD1();
	for (const bad of ["", "OAuth", "kv; DROP TABLE x", "kv-v1", "1kv"]) {
		assert.throws(() => createD1Kv(db, bad), TypeError);
	}
});

test("put refuses non-string values instead of coercing them", async () => {
	const db = new SqliteD1();
	const store = createD1Kv(db, "portfolio_kv_v1");
	await assert.rejects(() => store.put("k", { o: 1 }), TypeError);
});
