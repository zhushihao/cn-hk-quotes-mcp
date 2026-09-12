import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	LIVE_UNIVERSE_KV_KEY,
	computeLiveUniverseHash,
	resolveLiveUniverseFreshness,
	validateLiveUniverse,
} from "../src/live-universe.ts";
import {
	LIVE_COMPLETE_MAX_AGE_SECONDS,
	LKG_VALID_MAX_AGE_SECONDS,
	PORTFOLIO_STATUS_KV_KEY,
	derivePortfolioState,
	mostConservativePortfolioState,
	readPortfolioStatus,
	resolvePortfolioPresentation,
	validatePortfolioStatus,
	writePortfolioStatus,
} from "../src/portfolio-status.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const NOW = new Date("2026-09-14T10:00:00+08:00");
const LRCCA_FRESH = "2026-09-14T09:30:02+08:00";
const LRCCA_LKG = "2026-09-12T09:30:00+08:00";
const LRCCA_EXPIRED = "2026-09-01T09:30:00+08:00";

function makeStatus(overrides = {}) {
	return {
		schema_version: "portfolio-status/1",
		generated_at: "2026-09-14T09:31:00+08:00",
		state: "LIVE_COMPLETE",
		last_real_complete_confirmed_at: LRCCA_FRESH,
		universe_content_hash: HASH_A,
		source_manifest_hash: HASH_B,
		...overrides,
	};
}

async function makeUniverse(
	active = [{ market: "CN", exchange: "SZ", code: "300308" }],
	generatedAt = "2026-09-14T09:30:00+08:00",
) {
	const payload = {
		schema_version: "quote-universe/1",
		generated_at: generatedAt,
		source_manifest_hash: HASH_B,
		active,
		content_hash: await computeLiveUniverseHash(active),
	};
	const validated = await validateLiveUniverse(payload);
	return { ...validated, received_at: "2026-09-14T09:30:01+08:00" };
}

/**
 * 与 `src/index.ts` 的 `resolveLivePresentation()` 同构的组合（index.ts 使用无扩展名
 * ESM import，node --test 无法直接导入，故在此复刻同一组合路径并逐个断言口径）。
 */
function present({ universe = null, status = null, now = NOW } = {}) {
	const anchor = universe
		? resolveLiveUniverseFreshness(universe, {
				lrcca: status?.last_real_complete_confirmed_at ?? null,
				now,
			})
		: null;
	return resolvePortfolioPresentation({
		universePresent: universe !== null,
		universeContentHash: universe?.content_hash ?? null,
		universeManifestHash: universe?.source_manifest_hash ?? null,
		status,
		anchor: anchor
			? {
					anchor: anchor.anchor,
					anchor_fallback: anchor.anchor_fallback,
					fresh: anchor.fresh,
				}
			: null,
		now,
	});
}

function memoryKv() {
	const values = new Map();
	return {
		values,
		async get(key) {
			return values.get(key) ?? null;
		},
		async put(key, value) {
			values.set(key, value);
		},
	};
}

function extractFunctionBody(source, signature) {
	const start = source.indexOf(signature);
	assert.ok(start >= 0, `missing function: ${signature}`);
	const bodyStart = source.indexOf("{", start);
	assert.ok(bodyStart > start, `missing body: ${signature}`);
	const end = source.indexOf("\n}", bodyStart);
	assert.ok(end > bodyStart, `unterminated function: ${signature}`);
	return source.slice(bodyStart, end + 2);
}

test("portfolio-status/1 is the exact six-key contract with a locked canonical vector", () => {
	const status = makeStatus();
	const validated = validatePortfolioStatus(status);
	assert.deepEqual(Object.keys(validated).sort(), [
		"generated_at",
		"last_real_complete_confirmed_at",
		"schema_version",
		"source_manifest_hash",
		"state",
		"universe_content_hash",
	]);
	assert.deepEqual(validated, status);
	// KV key 与 live-portfolio/current 平级、同 binding；新契约不动 quote-universe/1。
	assert.equal(PORTFOLIO_STATUS_KV_KEY, "live-portfolio/status");
	assert.equal(LIVE_UNIVERSE_KV_KEY, "live-portfolio/current");

	// 跨语言固定向量：LIVE 侧 status_doc.py 必须以同一规范化字节构造本件。
	const sorted = {};
	for (const key of Object.keys(status).sort()) sorted[key] = status[key];
	const canonical = JSON.stringify(sorted);
	assert.equal(
		canonical,
		'{"generated_at":"2026-09-14T09:31:00+08:00","last_real_complete_confirmed_at":"2026-09-14T09:30:02+08:00","schema_version":"portfolio-status/1","source_manifest_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","state":"LIVE_COMPLETE","universe_content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
	);
	assert.equal(
		createHash("sha256").update(canonical).digest("hex"),
		"4304f5186b788d341d8d5b9036f18c2c1a5771a63221b0ad5a5af67a78f10c84",
	);
});

test("portfolio-status/1 rejects extra keys, missing keys, and forbidden decoys", () => {
	const status = makeStatus();
	for (const key of [
		"position_qty",
		"qty",
		"name",
		"bucket",
		"portfolio_bucket",
		"source_account_type",
		"account",
		"orders",
		"manifest_path",
		"d:/QuantPro/quantpro-qmt",
	]) {
		assert.throws(
			() => validatePortfolioStatus({ ...status, [key]: 1 }),
			/not allowed/,
			`expected ${key} to be rejected`,
		);
	}
	for (const key of Object.keys(status)) {
		const without = { ...status };
		delete without[key];
		assert.throws(
			() => validatePortfolioStatus(without),
			new RegExp(`portfolio_status\\.${key} is required`),
			`expected missing ${key} to be rejected`,
		);
	}
	assert.throws(() => validatePortfolioStatus(null), /must be an object/);
	assert.throws(() => validatePortfolioStatus([status]), /must be an object/);
	assert.throws(
		() => validatePortfolioStatus({ ...status, schema_version: "quote-universe/1" }),
		/schema_version must be/,
	);
});

test("state is exactly three values", () => {
	for (const state of [
		"live_complete",
		"OK",
		"LKG",
		"UNKNOWN",
		"",
		null,
		12,
		["LIVE_COMPLETE"],
	]) {
		assert.throws(
			() => validatePortfolioStatus(makeStatus({ state })),
			/state must be one of/,
			`expected ${String(state)} to be rejected`,
		);
	}
	assert.equal(validatePortfolioStatus(makeStatus({ state: "LKG_VALID" })).state, "LKG_VALID");
	assert.equal(
		validatePortfolioStatus(
			makeStatus({ state: "PORTFOLIO_UNKNOWN", last_real_complete_confirmed_at: null }),
		).state,
		"PORTFOLIO_UNKNOWN",
	);
});

test("hash shapes, timestamps, and state/LRCCA consistency are validated", () => {
	const status = makeStatus();
	for (const bad of [
		`sha256:${"A".repeat(64)}`,
		`sha256:${"a".repeat(63)}`,
		"a".repeat(64),
		"",
		42,
		null,
	]) {
		assert.throws(
			() => validatePortfolioStatus({ ...status, universe_content_hash: bad }),
			/universe_content_hash must be/,
		);
		assert.throws(
			() => validatePortfolioStatus({ ...status, source_manifest_hash: bad }),
			/source_manifest_hash must be/,
		);
	}
	assert.throws(
		() => validatePortfolioStatus({ ...status, generated_at: "" }),
		/generated_at must be a non-empty string/,
	);
	assert.throws(
		() => validatePortfolioStatus({ ...status, generated_at: "not-a-timestamp" }),
		/generated_at must be a parseable timestamp/,
	);
	assert.throws(
		() =>
			validatePortfolioStatus({
				...status,
				last_real_complete_confirmed_at: "not-a-timestamp",
			}),
		/last_real_complete_confirmed_at must be a parseable timestamp/,
	);
	// 规格 §5.2 不变式：没有 LRCCA 就不可能有 LIVE_COMPLETE / LKG_VALID 基线。
	for (const state of ["LIVE_COMPLETE", "LKG_VALID"]) {
		assert.throws(
			() =>
				validatePortfolioStatus(
					makeStatus({ state, last_real_complete_confirmed_at: null }),
				),
			/requires last_real_complete_confirmed_at/,
		);
	}
	assert.doesNotThrow(() =>
		validatePortfolioStatus(
			makeStatus({
				state: "PORTFOLIO_UNKNOWN",
				last_real_complete_confirmed_at: LRCCA_EXPIRED,
			}),
		),
	);
});

test("three-state boundaries: exactly 24h, exactly 10 days, one second beyond", () => {
	const at = (offsetSeconds) => new Date(NOW.getTime() - offsetSeconds * 1000).toISOString();
	const derive = (lastRealCompleteConfirmedAt) =>
		derivePortfolioState({ lastRealCompleteConfirmedAt, lkgPresent: true, now: NOW });
	assert.equal(LIVE_COMPLETE_MAX_AGE_SECONDS, 86400);
	assert.equal(LKG_VALID_MAX_AGE_SECONDS, 864000);
	assert.equal(derive(at(0)), "LIVE_COMPLETE");
	assert.equal(derive(at(LIVE_COMPLETE_MAX_AGE_SECONDS)), "LIVE_COMPLETE");
	assert.equal(derive(at(LIVE_COMPLETE_MAX_AGE_SECONDS + 1)), "LKG_VALID");
	// 长假（连续闭市 ≤9 天）落在 LKG_VALID 内；第 10 天含当日。
	assert.equal(derive(at(9 * 86400)), "LKG_VALID");
	assert.equal(derive(at(LKG_VALID_MAX_AGE_SECONDS)), "LKG_VALID");
	assert.equal(derive(at(LKG_VALID_MAX_AGE_SECONDS + 1)), "PORTFOLIO_UNKNOWN");
	assert.equal(derive(at(2 * 365 * 86400)), "PORTFOLIO_UNKNOWN");
});

test("no baseline or untrustworthy timestamps derive PORTFOLIO_UNKNOWN", () => {
	const future = (offsetSeconds) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();
	assert.equal(
		derivePortfolioState({
			lastRealCompleteConfirmedAt: LRCCA_FRESH,
			lkgPresent: false,
			now: NOW,
		}),
		"PORTFOLIO_UNKNOWN",
	);
	assert.equal(
		derivePortfolioState({ lastRealCompleteConfirmedAt: null, lkgPresent: true, now: NOW }),
		"PORTFOLIO_UNKNOWN",
	);
	assert.equal(
		derivePortfolioState({
			lastRealCompleteConfirmedAt: "not-a-timestamp",
			lkgPresent: true,
			now: NOW,
		}),
		"PORTFOLIO_UNKNOWN",
	);
	assert.equal(
		derivePortfolioState({
			lastRealCompleteConfirmedAt: future(3600),
			lkgPresent: true,
			now: NOW,
		}),
		"PORTFOLIO_UNKNOWN",
	);
	assert.equal(
		derivePortfolioState({
			lastRealCompleteConfirmedAt: future(60),
			lkgPresent: true,
			now: NOW,
		}),
		"LIVE_COMPLETE",
	);
	// 保守序：PORTFOLIO_UNKNOWN > LKG_VALID > LIVE_COMPLETE。
	assert.equal(mostConservativePortfolioState("LIVE_COMPLETE", "LKG_VALID"), "LKG_VALID");
	assert.equal(
		mostConservativePortfolioState("LKG_VALID", "PORTFOLIO_UNKNOWN"),
		"PORTFOLIO_UNKNOWN",
	);
	assert.equal(mostConservativePortfolioState(), "PORTFOLIO_UNKNOWN");
});

test("J-4: the Worker recheck takes the more conservative state on drift", async () => {
	const universe = await makeUniverse([{ market: "CN", exchange: "SZ", code: "300308" }]);
	const matching = { universe_content_hash: universe.content_hash };

	const fresh = present({ universe, status: validatePortfolioStatus(makeStatus(matching)) });
	assert.equal(fresh.portfolio_state, "LIVE_COMPLETE");
	assert.equal(fresh.stale, false);
	assert.equal(fresh.apply_overlay, true);
	assert.equal(fresh.state_reconciled, false);

	// 自述 LIVE_COMPLETE 但 LRCCA 已是 2 天前 → 复核降级为 LKG_VALID（供数 + 标记）。
	const drifted = present({
		universe,
		status: validatePortfolioStatus(
			makeStatus({ ...matching, last_real_complete_confirmed_at: LRCCA_LKG }),
		),
	});
	assert.equal(drifted.portfolio_state, "LKG_VALID");
	assert.equal(drifted.declared_state, "LIVE_COMPLETE");
	assert.equal(drifted.state_reconciled, true);
	assert.equal(drifted.stale, true);
	assert.equal(drifted.apply_overlay, true);

	// 自述较保守时复核不得上调。
	const conservative = present({
		universe,
		status: validatePortfolioStatus(makeStatus({ ...matching, state: "LKG_VALID" })),
	});
	assert.equal(conservative.portfolio_state, "LKG_VALID");
	assert.equal(conservative.state_reconciled, false);

	// LRCCA 已过 10 天 → PORTFOLIO_UNKNOWN，不应用 overlay。
	const expired = present({
		universe,
		status: validatePortfolioStatus(
			makeStatus({ ...matching, last_real_complete_confirmed_at: LRCCA_EXPIRED }),
		),
	});
	assert.equal(expired.portfolio_state, "PORTFOLIO_UNKNOWN");
	assert.equal(expired.apply_overlay, false);
	assert.equal(expired.stale, true);
});

test("J-13: cross-check mismatch degrades to LKG_VALID at most, without declaring a fault", async () => {
	const universe = await makeUniverse([{ market: "CN", exchange: "SZ", code: "300308" }]);
	const mismatched = present({
		universe,
		status: validatePortfolioStatus(makeStatus({ universe_content_hash: HASH_A })),
	});
	assert.equal(mismatched.cross_check_mismatch, true);
	assert.equal(mismatched.portfolio_state, "LKG_VALID");
	assert.equal(mismatched.stale, true);
	assert.equal(mismatched.apply_overlay, true);
	assert.notEqual(mismatched.portfolio_state, "PORTFOLIO_UNKNOWN");
});

test("C-3/C-5: missing status doc reads as PORTFOLIO_UNKNOWN and never applies the LIVE overlay", async () => {
	const universe = await makeUniverse([{ market: "CN", exchange: "SZ", code: "300308" }]);
	const missing = present({ universe, status: null });
	assert.equal(missing.portfolio_state, "PORTFOLIO_UNKNOWN");
	assert.equal(missing.state_source, "STATUS_DOC_MISSING");
	assert.equal(missing.apply_overlay, false);
	assert.equal(missing.stale, true);
	// 双轨锚：状态件缺失 → 锚回退 generated_at，并留痕 anchor_fallback=true。
	assert.equal(missing.freshness_anchor, "GENERATED_AT");
	assert.equal(missing.freshness_anchor_fallback, true);
	assert.equal(missing.fresh, true);

	// 过期 universe + 无状态件 → 锚不新鲜，仍不应用 overlay、不报错。
	const staleUniverse = { ...universe, generated_at: "2026-08-20T09:30:00+08:00" };
	const stale = present({ universe: staleUniverse, status: null });
	assert.equal(stale.fresh, false);
	assert.equal(stale.freshness_anchor_fallback, true);
	assert.equal(stale.apply_overlay, false);

	// 状态件提供 LRCCA → 锚迁到 LRCCA（不回落），且 hash 一致时按 LIVE_COMPLETE 供数。
	const withDoc = present({
		universe,
		status: validatePortfolioStatus(
			makeStatus({ universe_content_hash: universe.content_hash }),
		),
	});
	assert.equal(withDoc.freshness_anchor, "LRCCA");
	assert.equal(withDoc.freshness_anchor_fallback, false);
	assert.equal(withDoc.portfolio_state, "LIVE_COMPLETE");

	// 无 universe（KV 未初始化 / 已撤回）→ UNKNOWN，无锚。
	const empty = present({});
	assert.equal(empty.portfolio_state, "PORTFOLIO_UNKNOWN");
	assert.equal(empty.freshness_anchor, null);
	assert.equal(empty.apply_overlay, false);
});

test("portfolio_state never leaves the three-state enum in presented output", async () => {
	const universe = await makeUniverse();
	const scenarios = [
		present({}),
		present({ universe }),
		present({ universe, status: null }),
		present({
			universe,
			status: validatePortfolioStatus(
				makeStatus({ universe_content_hash: universe.content_hash }),
			),
		}),
		present({
			universe,
			status: validatePortfolioStatus(makeStatus({ universe_content_hash: HASH_A })),
		}),
		present({
			universe,
			status: validatePortfolioStatus(
				makeStatus({
					universe_content_hash: universe.content_hash,
					last_real_complete_confirmed_at: LRCCA_EXPIRED,
				}),
			),
		}),
	];
	for (const scenario of scenarios) {
		assert.match(scenario.portfolio_state, /^(LIVE_COMPLETE|LKG_VALID|PORTFOLIO_UNKNOWN)$/);
	}
});

test("KV status key is last-known-good: invalid writes never overwrite the previous status doc", async () => {
	const kv = memoryKv();
	const status = makeStatus();
	const stored = await writePortfolioStatus(kv, status, "2026-09-14T09:32:00+08:00");
	assert.equal(stored.received_at, "2026-09-14T09:32:00+08:00");
	const before = kv.values.get(PORTFOLIO_STATUS_KV_KEY);

	await assert.rejects(() => writePortfolioStatus(kv, { ...status, qty: 100 }), /not allowed/);
	await assert.rejects(
		() =>
			writePortfolioStatus(
				kv,
				makeStatus({ state: "LIVE_COMPLETE", last_real_complete_confirmed_at: null }),
			),
		/requires last_real_complete_confirmed_at/,
	);
	assert.equal(kv.values.get(PORTFOLIO_STATUS_KV_KEY), before);
	const read = await readPortfolioStatus(kv);
	assert.equal(read?.state, "LIVE_COMPLETE");
	assert.equal(read?.received_at, "2026-09-14T09:32:00+08:00");
	assert.equal(read?.universe_content_hash, HASH_A);

	const empty = memoryKv();
	assert.equal(await readPortfolioStatus(empty), null);
	await assert.rejects(
		() => writePortfolioStatus(empty, makeStatus({ schema_version: "portfolio-status/9" })),
		/schema_version must be/,
	);
	assert.equal(empty.values.has(PORTFOLIO_STATUS_KV_KEY), false);

	const corrupt = memoryKv();
	corrupt.values.set(PORTFOLIO_STATUS_KV_KEY, "{not json");
	await assert.rejects(() => readPortfolioStatus(corrupt), /invalid JSON/);
	const noReceivedAt = memoryKv();
	noReceivedAt.values.set(PORTFOLIO_STATUS_KV_KEY, JSON.stringify(status));
	await assert.rejects(() => readPortfolioStatus(noReceivedAt), /missing received_at/);
	const tampered = memoryKv();
	tampered.values.set(
		PORTFOLIO_STATUS_KV_KEY,
		JSON.stringify({
			...status,
			state: "LIVE_COMPLETE",
			last_real_complete_confirmed_at: null,
			received_at: "2026-09-14T09:32:00+08:00",
		}),
	);
	await assert.rejects(
		() => readPortfolioStatus(tampered),
		/requires last_real_complete_confirmed_at/,
	);
});

test("C-1 wiring: the status endpoint authenticates via GitHub identity before writing KV", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /if \(url\.pathname === "\/api\/github-auth\/portfolio-status"\) \{/);
	assert.match(source, /return handleGithubAuthPortfolioStatus\(request, env\);/);
	const body = extractFunctionBody(
		source,
		"async function handleGithubAuthPortfolioStatus(request: Request, env: Env)",
	);
	const authIndex = body.indexOf("await verifyGithubAccessToken(githubBearerToken(request))");
	const writeIndex = body.indexOf("await writePortfolioStatus(env.PORTFOLIO_UNIVERSE, payload)");
	assert.ok(authIndex > 0, "handler must verify the GitHub identity");
	assert.ok(writeIndex > authIndex, "identity verification must precede the KV write");
	assert.match(body, /GITHUB_AUTH_FAILED/);
	assert.match(body, /PAYLOAD_TOO_LARGE/);
	assert.match(body, /INVALID_PORTFOLIO_STATUS/);
	assert.match(body, /PORTFOLIO_STATUS_MAX_PAYLOAD_BYTES/);
	// 状态件写入复用既有 PORTFOLIO_UNIVERSE binding（与 live-portfolio/current 平级）。
	assert.match(body, /writePortfolioStatus\(env\.PORTFOLIO_UNIVERSE/);
});

test("C-3 wiring: control-plane-status exposes only enum/boolean state fields", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const body = extractFunctionBody(source, "async function getControlPlaneStatus(env: Env)");
	assert.match(body, /portfolio_state: live\.presentation\.portfolio_state,/);
	assert.match(body, /stale: live\.presentation\.stale,/);
	assert.match(body, /freshness_anchor: live\.presentation\.freshness_anchor,/);
	assert.match(body, /freshness_anchor_fallback: live\.presentation\.freshness_anchor_fallback,/);
	for (const forbidden of [
		"declared_state",
		"cross_check_mismatch",
		"universe_content_hash",
		"source_manifest_hash",
		"active_count",
		"active:",
	]) {
		assert.ok(!body.includes(forbidden), `control-plane-status must not expose ${forbidden}`);
	}
});
