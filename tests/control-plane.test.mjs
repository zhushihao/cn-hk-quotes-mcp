import assert from "node:assert/strict";
import test from "node:test";

import {
	CONTROL_PROBE_PATH,
	CONTROL_REF,
	CONTROL_UNIVERSE_PATH,
	probePrivateControlPlane,
	syncLiveUniverseFromPrivateGithub,
} from "../src/control-plane.ts";
import { computeLiveUniverseHash } from "../src/live-universe.ts";

function fakeKv() {
	const values = new Map();
	return {
		values,
		get: async (key) => values.get(key) ?? null,
		put: async (key, value) => { values.set(key, value); },
	};
}

async function makeUniverse() {
	const active = [{ market: "CN", exchange: "SZ", code: "300308" }];
	return {
		schema_version: "quote-universe/1",
		generated_at: new Date().toISOString(),
		source_manifest_hash: `sha256:${"2".repeat(64)}`,
		active,
		content_hash: await computeLiveUniverseHash(active),
	};
}

test("private control probe uses the dedicated runtime ref without exposing holdings", async () => {
	const originalFetch = globalThis.fetch;
	let seenUrl = "";
	let seenAuth = "";
	globalThis.fetch = async (url, init = {}) => {
		seenUrl = String(url);
		seenAuth = new Headers(init.headers).get("Authorization") ?? "";
		return new Response(JSON.stringify({ schema: "quantpro-control-probe/1" }), { status: 200 });
	};
	try {
		assert.equal(await probePrivateControlPlane({ GITHUB_TOKEN: "secret" }), true);
		assert.match(seenUrl, new RegExp(CONTROL_PROBE_PATH.replace("/", "\\/")));
		assert.match(seenUrl, new RegExp(`ref=${CONTROL_REF}`));
		assert.equal(seenAuth, "Bearer secret");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("private quote universe sync writes KV once and then hash-dedupes", async () => {
	const originalFetch = globalThis.fetch;
	const kv = fakeKv();
	const universe = await makeUniverse();
	let calls = 0;
	globalThis.fetch = async (url) => {
		calls += 1;
		assert.match(String(url), new RegExp(CONTROL_UNIVERSE_PATH.replace("/", "\\/")));
		return new Response(JSON.stringify(universe), { status: 200 });
	};
	try {
		const env = { GITHUB_TOKEN: "secret", PORTFOLIO_UNIVERSE: kv };
		const first = await syncLiveUniverseFromPrivateGithub(env);
		assert.equal(first.status, "SYNCED");
		assert.equal(first.universe?.content_hash, universe.content_hash);
		const second = await syncLiveUniverseFromPrivateGithub(env);
		assert.equal(second.status, "NO_CHANGE");
		assert.equal(calls, 2);
		assert.ok(kv.values.get("live-portfolio/current"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("missing private universe preserves an existing KV LKG", async () => {
	const originalFetch = globalThis.fetch;
	const kv = fakeKv();
	const universe = await makeUniverse();
	kv.values.set("live-portfolio/current", JSON.stringify({
		...universe,
		received_at: new Date().toISOString(),
	}));
	globalThis.fetch = async () => new Response("not found", { status: 404 });
	try {
		const result = await syncLiveUniverseFromPrivateGithub({
			GITHUB_TOKEN: "secret",
			PORTFOLIO_UNIVERSE: kv,
		});
		assert.equal(result.status, "NO_UNIVERSE");
		assert.equal(result.universe?.content_hash, universe.content_hash);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
