import assert from "node:assert/strict";
import test from "node:test";

import {
	PORTFOLIO_UNIVERSE_BASELINE_KV_KEY,
	PORTFOLIO_UNIVERSE_DELTA_KV_KEY,
	canonicalPortfolioCodes,
	readPortfolioCompleteBaseline,
	readPortfolioUniverseDelta,
	recordPortfolioUniverseObservation,
} from "../src/portfolio-delta.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

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

function observation(overrides = {}) {
	return {
		state: "LIVE_COMPLETE",
		current_complete_hash: HASH_A,
		active_codes: ["CN:002409", "HK:09696"],
		observed_at: "2026-09-13T09:00:00+08:00",
		...overrides,
	};
}

test("首次 LIVE_COMPLETE 只建立 baseline，不产生 delta", async () => {
	const kv = memoryKv();
	assert.equal(await recordPortfolioUniverseObservation(kv, observation()), null);

	const baseline = await readPortfolioCompleteBaseline(kv);
	assert.deepEqual(baseline, {
		schema_version: "portfolio_universe_complete_baseline_v1",
		current_complete_hash: HASH_A,
		codes: ["CN:002409", "HK:09696"],
		observed_at: "2026-09-13T09:00:00+08:00",
		eligible: true,
		last_state: "LIVE_COMPLETE",
		last_observed_hash: HASH_A,
		last_observed_at: "2026-09-13T09:00:00+08:00",
	});
	assert.equal(await readPortfolioUniverseDelta(kv), null);
});

test("连续 LIVE_COMPLETE 只比较 market:code，并产生 add/remove delta", async () => {
	const kv = memoryKv();
	await recordPortfolioUniverseObservation(kv, observation());

	const delta = await recordPortfolioUniverseObservation(
		kv,
		observation({
			current_complete_hash: HASH_B,
			active_codes: [
				// Extra exchange/quantity/path-like fields must never enter the delta.
				{
					market: "CN",
					code: "002409",
					exchange: "SZ",
					position_qty: 100,
					path: "D:/private",
				},
				{ market: "CN", code: "300308", exchange: "SZ" },
				{ market: "HK", code: "09988", exchange: "HK" },
			],
			observed_at: "2026-09-13T10:00:00+08:00",
		}),
	);

	assert.deepEqual(delta, {
		previous_complete_hash: HASH_A,
		current_complete_hash: HASH_B,
		added_codes: ["CN:300308", "HK:09988"],
		removed_codes: ["HK:09696"],
		observed_at: "2026-09-13T10:00:00+08:00",
	});
	assert.deepEqual(Object.keys(delta).sort(), [
		"added_codes",
		"current_complete_hash",
		"observed_at",
		"previous_complete_hash",
		"removed_codes",
	]);
	assert.deepEqual(await readPortfolioUniverseDelta(kv), delta);
});

test("相同 hash 无事件，重复 replay 保持 latest delta 不变", async () => {
	const kv = memoryKv();
	await recordPortfolioUniverseObservation(kv, observation());
	const changed = observation({
		current_complete_hash: HASH_B,
		active_codes: ["CN:002409", "CN:300308"],
		observed_at: "2026-09-13T10:00:00+08:00",
	});
	const first = await recordPortfolioUniverseObservation(kv, changed);
	const storedAfterFirst = kv.values.get(PORTFOLIO_UNIVERSE_DELTA_KV_KEY);
	assert.ok(first);

	assert.equal(await recordPortfolioUniverseObservation(kv, changed), null);
	assert.equal(kv.values.get(PORTFOLIO_UNIVERSE_DELTA_KV_KEY), storedAfterFirst);
	assert.deepEqual(await readPortfolioUniverseDelta(kv), first);
});

test("baseline 写入失败后 replay 覆盖同一 delta，绝不丢失事件", async () => {
	const kv = memoryKv();
	await recordPortfolioUniverseObservation(kv, observation());
	const changed = observation({
		current_complete_hash: HASH_B,
		active_codes: ["CN:002409", "CN:300308"],
		observed_at: "2026-09-13T10:00:00+08:00",
	});
	const originalPut = kv.put.bind(kv);
	let rejectBaseline = true;
	kv.put = async (key, value) => {
		if (rejectBaseline && key === PORTFOLIO_UNIVERSE_BASELINE_KV_KEY) {
			throw new Error("synthetic baseline write failure");
		}
		return originalPut(key, value);
	};

	await assert.rejects(
		() => recordPortfolioUniverseObservation(kv, changed),
		/synthetic baseline write failure/,
	);
	const persistedEvent = await readPortfolioUniverseDelta(kv);
	assert.equal((await readPortfolioCompleteBaseline(kv))?.current_complete_hash, HASH_A);
	assert.deepEqual(persistedEvent?.added_codes, ["CN:300308"]);

	rejectBaseline = false;
	const replay = await recordPortfolioUniverseObservation(kv, changed);
	assert.deepEqual(replay, persistedEvent);
	assert.equal((await readPortfolioCompleteBaseline(kv))?.current_complete_hash, HASH_B);
});

test("LKG_VALID/PORTFOLIO_UNKNOWN 不确认 removal，之后 complete 重新建立基线", async () => {
	const kv = memoryKv();
	await recordPortfolioUniverseObservation(kv, observation());

	assert.equal(
		await recordPortfolioUniverseObservation(
			kv,
			observation({
				state: "LKG_VALID",
				current_complete_hash: HASH_B,
				active_codes: ["CN:300308"],
				observed_at: "2026-09-13T10:00:00+08:00",
			}),
		),
		null,
	);
	const afterLkg = await readPortfolioCompleteBaseline(kv);
	assert.equal(afterLkg?.current_complete_hash, HASH_A);
	assert.equal(afterLkg?.eligible, false);
	assert.equal(afterLkg?.last_state, "LKG_VALID");
	assert.equal(afterLkg?.last_observed_hash, HASH_B);
	assert.equal(afterLkg?.codes.includes("HK:09696"), true);
	// Same LKG payload is a harmless replay, not a conflict with the earlier
	// complete baseline hash.
	assert.equal(
		await recordPortfolioUniverseObservation(
			kv,
			observation({
				state: "LKG_VALID",
				current_complete_hash: HASH_B,
				active_codes: ["CN:300308"],
				observed_at: "2026-09-13T10:00:00+08:00",
			}),
		),
		null,
	);

	assert.equal(
		await recordPortfolioUniverseObservation(
			kv,
			observation({
				state: "PORTFOLIO_UNKNOWN",
				current_complete_hash: HASH_C,
				active_codes: [],
				observed_at: "2026-09-13T11:00:00+08:00",
			}),
		),
		null,
	);
	assert.equal((await readPortfolioCompleteBaseline(kv))?.last_state, "PORTFOLIO_UNKNOWN");

	// This complete result must not infer removals across the LKG/UNKNOWN gap.
	assert.equal(
		await recordPortfolioUniverseObservation(
			kv,
			observation({
				current_complete_hash: HASH_C,
				active_codes: ["CN:300308"],
				observed_at: "2026-09-13T12:00:00+08:00",
			}),
		),
		null,
	);
	const renewed = await readPortfolioCompleteBaseline(kv);
	assert.equal(renewed?.current_complete_hash, HASH_C);
	assert.deepEqual(renewed?.codes, ["CN:300308"]);
	assert.equal(renewed?.eligible, true);
});

test("无基线时的 UNKNOWN 不写入伪造基线", async () => {
	const kv = memoryKv();
	assert.equal(
		await recordPortfolioUniverseObservation(
			kv,
			observation({ state: "PORTFOLIO_UNKNOWN", active_codes: [] }),
		),
		null,
	);
	assert.equal(kv.values.has(PORTFOLIO_UNIVERSE_BASELINE_KV_KEY), false);
});

test("损坏或非法私域存储 fail-closed，不产生事件", async () => {
	const corruptBaseline = memoryKv();
	corruptBaseline.values.set(PORTFOLIO_UNIVERSE_BASELINE_KV_KEY, "{broken");
	await assert.rejects(
		() => recordPortfolioUniverseObservation(corruptBaseline, observation()),
		/stored portfolio baseline is invalid JSON/,
	);

	const illegalBaseline = memoryKv();
	illegalBaseline.values.set(
		PORTFOLIO_UNIVERSE_BASELINE_KV_KEY,
		JSON.stringify({ current_complete_hash: HASH_A }),
	);
	await assert.rejects(
		() => recordPortfolioUniverseObservation(illegalBaseline, observation()),
		/portfolio_complete_baseline.*required/,
	);

	const corruptDelta = memoryKv();
	corruptDelta.values.set(PORTFOLIO_UNIVERSE_DELTA_KV_KEY, "not-json");
	await assert.rejects(
		() => recordPortfolioUniverseObservation(corruptDelta, observation()),
		/stored portfolio delta is invalid JSON/,
	);
});

test("code identity is canonical, sorted, unique, and excludes exchange/path fields", () => {
	assert.deepEqual(
		canonicalPortfolioCodes([
			{ market: "HK", code: "09696", exchange: "HK", position_qty: 10 },
			{ market: "CN", code: "002409", exchange: "SZ", path: "private" },
		]),
		["CN:002409", "HK:09696"],
	);
	assert.throws(
		() => canonicalPortfolioCodes(["CN:002409", "CN:002409"]),
		/duplicate code identities/,
	);
	assert.throws(() => canonicalPortfolioCodes(["SZ:002409"]), /CN:<5-6 digits> or HK/);
	assert.throws(() => canonicalPortfolioCodes(["CN:ABC"]), /CN:<5-6 digits> or HK/);
});
