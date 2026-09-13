/**
 * C3: LIVE portfolio-universe delta.
 *
 * This module deliberately has no network or research dependency.  The caller
 * supplies the already authenticated LIVE observation, and this module only
 * compares code identities and persists the last-known-good reducer state.
 *
 * `portfolio_universe_delta_v1` is represented by the exact five-key object
 * returned by this module.  The schema name is a contract label, not an extra
 * response field.
 */

export const PORTFOLIO_UNIVERSE_DELTA_SCHEMA = "portfolio_universe_delta_v1" as const;
export const PORTFOLIO_UNIVERSE_BASELINE_SCHEMA =
	"portfolio_universe_complete_baseline_v1" as const;

/** These keys are intentionally private to the existing PORTFOLIO_UNIVERSE KV. */
export const PORTFOLIO_UNIVERSE_BASELINE_KV_KEY = "live-portfolio/private/complete-baseline-v1";
export const PORTFOLIO_UNIVERSE_DELTA_KV_KEY = "live-portfolio/private/latest-delta-v1";

export type PortfolioDeltaState = "LIVE_COMPLETE" | "LKG_VALID" | "PORTFOLIO_UNKNOWN";
export type PortfolioCodeMarket = "CN" | "HK";

/**
 * A code identity may be supplied as `CN:123456` / `HK:01234`, or as the
 * market+code projection of the existing `quote-universe/1` active rows.
 * Exchange, quantity, and path fields are deliberately ignored.
 */
export type PortfolioCodeInput =
	| string
	| {
			market: PortfolioCodeMarket;
			code: string;
	  };

export type PortfolioUniverseObservation = {
	state: PortfolioDeltaState;
	current_complete_hash: string;
	active_codes: readonly PortfolioCodeInput[];
	observed_at: string;
};

/** Private reducer state.  `eligible=false` means a non-complete observation
 * occurred after this baseline, so the next complete observation starts a new
 * baseline and cannot infer removals across the gap. */
export type PortfolioCompleteBaseline = {
	schema_version: typeof PORTFOLIO_UNIVERSE_BASELINE_SCHEMA;
	current_complete_hash: string;
	codes: string[];
	observed_at: string;
	eligible: boolean;
	last_state: PortfolioDeltaState;
	last_observed_hash: string;
	last_observed_at: string;
};

/** The public C3 contract.  Do not add schema, quantity, exchange, or path. */
export type PortfolioUniverseDelta = {
	previous_complete_hash: string;
	current_complete_hash: string;
	added_codes: string[];
	removed_codes: string[];
	observed_at: string;
};

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CODE_PATTERN = /^(CN|HK):[0-9]{5,6}$/;
const STATES: readonly PortfolioDeltaState[] = ["LIVE_COMPLETE", "LKG_VALID", "PORTFOLIO_UNKNOWN"];
const STATE_SET = new Set<string>(STATES);

const DELTA_KEYS = new Set([
	"previous_complete_hash",
	"current_complete_hash",
	"added_codes",
	"removed_codes",
	"observed_at",
]);
const BASELINE_KEYS = new Set([
	"schema_version",
	"current_complete_hash",
	"codes",
	"observed_at",
	"eligible",
	"last_state",
	"last_observed_hash",
	"last_observed_at",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
	record: Record<string, unknown>,
	allowed: Set<string>,
	context: string,
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`${context}.${key} is not allowed`);
	}
	for (const key of allowed) {
		if (!(key in record)) throw new Error(`${context}.${key} is required`);
	}
}

function assertHash(value: unknown, context: string): string {
	if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
		throw new Error(`${context} must be sha256:<64 lowercase hex>`);
	}
	return value;
}

function assertTimestamp(value: unknown, context: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${context} must be a non-empty timestamp`);
	}
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`${context} must be a parseable timestamp`);
	}
	return value;
}

function assertState(value: unknown, context: string): PortfolioDeltaState {
	if (typeof value !== "string" || !STATE_SET.has(value)) {
		throw new Error(`${context} must be one of ${STATES.join(", ")}`);
	}
	return value as PortfolioDeltaState;
}

function canonicalCode(value: PortfolioCodeInput, context: string): string {
	let candidate: unknown;
	if (typeof value === "string") {
		candidate = value;
	} else if (isRecord(value)) {
		// Only market+code participate in identity.  Extra fields from an active
		// universe row never enter the output or hash comparison.
		candidate = `${value.market as string}:${value.code as string}`;
	} else {
		throw new Error(`${context} must be a market:code string or object`);
	}
	if (typeof candidate !== "string" || !CODE_PATTERN.test(candidate)) {
		throw new Error(`${context} must be CN:<5-6 digits> or HK:<5-6 digits>`);
	}
	return candidate;
}

/** Normalize, sort, and de-duplicate market:code identities. */
export function canonicalPortfolioCodes(
	values: readonly PortfolioCodeInput[],
	context = "active_codes",
): string[] {
	if (!Array.isArray(values)) throw new Error(`${context} must be an array`);
	const result = values.map((value, index) => canonicalCode(value, `${context}[${index}]`));
	const unique = new Set(result);
	if (unique.size !== result.length)
		throw new Error(`${context} contains duplicate code identities`);
	return [...unique].sort((left, right) => left.localeCompare(right));
}

function assertCanonicalCodes(value: unknown, context: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
	const codes = value.map((item, index) => canonicalCode(item as string, `${context}[${index}]`));
	if (codes.some((code, index) => code !== value[index])) {
		throw new Error(`${context} must contain canonical market:code strings only`);
	}
	if (new Set(codes).size !== codes.length)
		throw new Error(`${context} contains duplicate code identities`);
	const sorted = [...codes].sort((left, right) => left.localeCompare(right));
	if (sorted.some((code, index) => code !== codes[index])) {
		throw new Error(`${context} must be sorted canonically`);
	}
	return codes;
}

function assertNoOverlap(added: readonly string[], removed: readonly string[]): void {
	const removedSet = new Set(removed);
	if (added.some((code) => removedSet.has(code))) {
		throw new Error("delta added_codes and removed_codes must not overlap");
	}
}

function compareObservationTime(left: string, right: string): number {
	return Date.parse(left) - Date.parse(right);
}

type NormalizedPortfolioUniverseObservation = Omit<PortfolioUniverseObservation, "active_codes"> & {
	active_codes: string[];
};

function validateObservation(value: unknown): NormalizedPortfolioUniverseObservation {
	if (!isRecord(value)) throw new Error("portfolio delta observation must be an object");
	const state = assertState(value.state, "observation.state");
	const currentCompleteHash = assertHash(
		value.current_complete_hash,
		"observation.current_complete_hash",
	);
	const observedAt = assertTimestamp(value.observed_at, "observation.observed_at");
	if (!Array.isArray(value.active_codes)) {
		throw new Error("observation.active_codes must be an array");
	}
	const activeCodes = canonicalPortfolioCodes(
		value.active_codes as PortfolioCodeInput[],
		"observation.active_codes",
	);
	return {
		state,
		current_complete_hash: currentCompleteHash,
		active_codes: activeCodes,
		observed_at: observedAt,
	};
}

/** Validate an exact private baseline payload before it can affect a reducer. */
export function validatePortfolioCompleteBaseline(value: unknown): PortfolioCompleteBaseline {
	if (!isRecord(value)) throw new Error("portfolio complete baseline must be an object");
	assertExactKeys(value, BASELINE_KEYS, "portfolio_complete_baseline");
	if (value.schema_version !== PORTFOLIO_UNIVERSE_BASELINE_SCHEMA) {
		throw new Error(`schema_version must be ${PORTFOLIO_UNIVERSE_BASELINE_SCHEMA}`);
	}
	const currentHash = assertHash(value.current_complete_hash, "current_complete_hash");
	const codes = assertCanonicalCodes(value.codes, "codes");
	const observedAt = assertTimestamp(value.observed_at, "observed_at");
	if (typeof value.eligible !== "boolean") throw new Error("eligible must be boolean");
	const lastState = assertState(value.last_state, "last_state");
	const lastObservedHash = assertHash(value.last_observed_hash, "last_observed_hash");
	const lastObservedAt = assertTimestamp(value.last_observed_at, "last_observed_at");
	if (value.eligible !== (lastState === "LIVE_COMPLETE")) {
		throw new Error("eligible must match last_state");
	}
	if (compareObservationTime(lastObservedAt, observedAt) < 0) {
		throw new Error("last_observed_at cannot precede observed_at");
	}
	return {
		schema_version: PORTFOLIO_UNIVERSE_BASELINE_SCHEMA,
		current_complete_hash: currentHash,
		codes,
		observed_at: observedAt,
		eligible: value.eligible,
		last_state: lastState,
		last_observed_hash: lastObservedHash,
		last_observed_at: lastObservedAt,
	};
}

/** Validate the exact five-key `portfolio_universe_delta_v1` payload. */
export function validatePortfolioUniverseDelta(value: unknown): PortfolioUniverseDelta {
	if (!isRecord(value)) throw new Error("portfolio universe delta must be an object");
	assertExactKeys(value, DELTA_KEYS, "portfolio_universe_delta");
	const previousHash = assertHash(value.previous_complete_hash, "previous_complete_hash");
	const currentHash = assertHash(value.current_complete_hash, "current_complete_hash");
	if (previousHash === currentHash) throw new Error("delta hashes must differ");
	const addedCodes = assertCanonicalCodes(value.added_codes, "added_codes");
	const removedCodes = assertCanonicalCodes(value.removed_codes, "removed_codes");
	assertNoOverlap(addedCodes, removedCodes);
	const observedAt = assertTimestamp(value.observed_at, "observed_at");
	return {
		previous_complete_hash: previousHash,
		current_complete_hash: currentHash,
		added_codes: addedCodes,
		removed_codes: removedCodes,
		observed_at: observedAt,
	};
}

export type PortfolioDeltaReduction = {
	baseline: PortfolioCompleteBaseline | null;
	delta: PortfolioUniverseDelta | null;
};

/**
 * Pure C3 reducer.
 *
 * A non-LIVE_COMPLETE observation invalidates continuity but retains the last
 * complete codes/hash.  A complete observation after that gap becomes a new
 * baseline with no removal event.  This is the key guard against turning an
 * LKG/UNKNOWN interval into a false portfolio removal.
 */
export function reducePortfolioUniverseDelta(
	previous: PortfolioCompleteBaseline | null,
	current: PortfolioUniverseObservation,
): PortfolioDeltaReduction {
	const observation = validateObservation(current);
	const baseline = previous === null ? null : validatePortfolioCompleteBaseline(previous);

	// Ignore an older replay/out-of-order observation. A conflicting observation
	// at the same timestamp is never allowed to manufacture a delta: an
	// incomplete one breaks continuity below, while a complete one is rebased.
	// This covers a self-declared COMPLETE status that LRCCA reconciliation later
	// downgrades to LKG/UNKNOWN without making the status write fail.
	if (
		baseline &&
		compareObservationTime(observation.observed_at, baseline.last_observed_at) < 0
	) {
		return { baseline, delta: null };
	}
	const sameTimestampConflict =
		baseline !== null &&
		compareObservationTime(observation.observed_at, baseline.last_observed_at) === 0 &&
		(observation.state !== baseline.last_state ||
			observation.current_complete_hash !== baseline.last_observed_hash);

	if (observation.state !== "LIVE_COMPLETE") {
		if (!baseline) return { baseline: null, delta: null };
		return {
			baseline: {
				...baseline,
				eligible: false,
				last_state: observation.state,
				last_observed_hash: observation.current_complete_hash,
				last_observed_at: observation.observed_at,
			},
			delta: null,
		};
	}

	const currentCodes = [...observation.active_codes];
	const nextBaseline: PortfolioCompleteBaseline = {
		schema_version: PORTFOLIO_UNIVERSE_BASELINE_SCHEMA,
		current_complete_hash: observation.current_complete_hash,
		codes: currentCodes,
		observed_at: observation.observed_at,
		eligible: true,
		last_state: "LIVE_COMPLETE",
		last_observed_hash: observation.current_complete_hash,
		last_observed_at: observation.observed_at,
	};

	// First complete, or first complete after an LKG/UNKNOWN gap: establish a
	// trusted baseline only.  No removal is inferred.
	if (!baseline || !baseline.eligible || sameTimestampConflict) {
		return { baseline: nextBaseline, delta: null };
	}

	// Same hash is an idempotent replay/refresh.  Do not write an event.
	if (baseline.current_complete_hash === observation.current_complete_hash) {
		return { baseline: nextBaseline, delta: null };
	}

	const previousCodes = new Set(baseline.codes);
	const currentCodeSet = new Set(currentCodes);
	const delta = validatePortfolioUniverseDelta({
		previous_complete_hash: baseline.current_complete_hash,
		current_complete_hash: observation.current_complete_hash,
		added_codes: currentCodes.filter((code) => !previousCodes.has(code)),
		removed_codes: baseline.codes.filter((code) => !currentCodeSet.has(code)),
		observed_at: observation.observed_at,
	});
	return { baseline: nextBaseline, delta };
}

async function readJson(
	kv: KVNamespace,
	key: string,
	description: string,
): Promise<unknown | null> {
	const raw = await kv.get(key);
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error(`${description} is invalid JSON`);
	}
}

export async function readPortfolioCompleteBaseline(
	kv: KVNamespace,
): Promise<PortfolioCompleteBaseline | null> {
	const parsed = await readJson(
		kv,
		PORTFOLIO_UNIVERSE_BASELINE_KV_KEY,
		"stored portfolio baseline",
	);
	return parsed === null ? null : validatePortfolioCompleteBaseline(parsed);
}

export async function writePortfolioCompleteBaseline(
	kv: KVNamespace,
	value: unknown,
): Promise<PortfolioCompleteBaseline> {
	const validated = validatePortfolioCompleteBaseline(value);
	await kv.put(PORTFOLIO_UNIVERSE_BASELINE_KV_KEY, JSON.stringify(validated));
	return validated;
}

export async function readPortfolioUniverseDelta(
	kv: KVNamespace,
): Promise<PortfolioUniverseDelta | null> {
	const parsed = await readJson(kv, PORTFOLIO_UNIVERSE_DELTA_KV_KEY, "stored portfolio delta");
	return parsed === null ? null : validatePortfolioUniverseDelta(parsed);
}

export async function writePortfolioUniverseDelta(
	kv: KVNamespace,
	value: unknown,
): Promise<PortfolioUniverseDelta> {
	const validated = validatePortfolioUniverseDelta(value);
	await kv.put(PORTFOLIO_UNIVERSE_DELTA_KV_KEY, JSON.stringify(validated));
	return validated;
}

/**
 * Read/validate the private reducer state, apply one authenticated LIVE
 * observation, and persist the resulting baseline and (when applicable) the
 * latest delta.  The latest delta is intentionally left untouched when no
 * event occurs, so same-hash replay is idempotent.
 */
export async function recordPortfolioUniverseObservation(
	kv: KVNamespace,
	observation: PortfolioUniverseObservation,
): Promise<PortfolioUniverseDelta | null> {
	const previous = await readPortfolioCompleteBaseline(kv);
	// Validate the latest event too.  A corrupt private value must fail closed,
	// even when the incoming observation itself would otherwise be harmless.
	await readPortfolioUniverseDelta(kv);
	const reduction = reducePortfolioUniverseDelta(previous, observation);
	// Write the observable event before advancing the baseline.  If the
	// baseline write fails, a replay recomputes and overwrites this same exact
	// event; reversing this order could permanently lose a delta after a
	// successful baseline write followed by a failed delta write.
	if (reduction.delta !== null) await writePortfolioUniverseDelta(kv, reduction.delta);
	if (reduction.baseline !== null) await writePortfolioCompleteBaseline(kv, reduction.baseline);
	return reduction.delta;
}
