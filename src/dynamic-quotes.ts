import { getSnapshotCounts, type QuoteSnapshot, type QuoteStock } from "./portfolio-validation.ts";

/**
 * C1 deliberately follows the existing LIVE identity contract.  BJ is not
 * part of the current QuoteStock contract, so it is rejected explicitly
 * instead of being silently mapped to SH/SZ.
 */
export type CanonicalMarket = "CN" | "HK";
export type SupportedExchange = "SH" | "SZ" | "HK";

export type CanonicalIdentity = {
	market: CanonicalMarket;
	exchange: SupportedExchange;
	code: string;
};

export type IdentityInput = {
	market?: unknown;
	exchange?: unknown;
	code?: unknown;
};

export type DynamicQuoteErrorCode =
	| "INVALID_IDENTITY"
	| "UNSUPPORTED_EXCHANGE"
	| "PROVIDER_UNAVAILABLE"
	| "PARTIAL_PROVIDER_FAILURE"
	| "INVALID_PROVIDER_QUOTE";

export type DynamicQuoteFailure = {
	identity: CanonicalIdentity | null;
	symbol: string | null;
	code: DynamicQuoteErrorCode;
	message: string;
};

/**
 * Structured C1 failure.  `rows` is always empty on a failed batch so callers
 * cannot accidentally merge a partial active universe and bypass fail-closed
 * LIVE coverage.
 */
export class DynamicQuoteError extends Error {
	readonly code: DynamicQuoteErrorCode;
	readonly failures: DynamicQuoteFailure[];
	readonly rows: QuoteStock[];

	constructor(
		code: DynamicQuoteErrorCode,
		message: string,
		failures: DynamicQuoteFailure[] = [],
	) {
		super(message);
		this.name = "DynamicQuoteError";
		this.code = code;
		this.failures = failures;
		this.rows = [];
	}
}

export type ProviderQuote = {
	name?: unknown;
	price?: unknown;
	change?: unknown;
	change_pct?: unknown;
	pre_close?: unknown;
	prev_close?: unknown;
	open?: unknown;
	high?: unknown;
	low?: unknown;
	pct_change?: unknown;
	volume?: unknown;
	amount?: unknown;
	market_status?: unknown;
	market_data_time?: unknown;
	source_update_time?: unknown;
	quote_time?: unknown;
	fetch_time?: unknown;
	age_seconds?: unknown;
	[key: string]: unknown;
};

export type QuoteProvider = (
	symbol: string,
	identity: CanonicalIdentity,
) => Promise<unknown> | unknown;

export type DynamicQuoteFetchOptions = {
	fetchQuote: QuoteProvider;
	now?: Date;
};

export type DynamicQuoteBatch = {
	identities: CanonicalIdentity[];
	symbols: string[];
	rows: QuoteStock[];
};

export type TencentHttpOptions = {
	fetchImpl?: typeof fetch;
	endpoint?: string;
	now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityFailure(
	code: DynamicQuoteErrorCode,
	message: string,
	identity: CanonicalIdentity | null = null,
	symbol: string | null = null,
): DynamicQuoteError {
	return new DynamicQuoteError(code, message, [{ identity, symbol, code, message }]);
}

function invalidIdentity(message: string): never {
	throw identityFailure("INVALID_IDENTITY", message);
}

/**
 * Validate and canonicalize a code before any provider request is made.
 * CN symbols are six digits; HK symbols are five digits and are kept with
 * their leading zeroes, matching the existing `market:code` identity.
 */
export function canonicalizeIdentity(input: unknown): CanonicalIdentity {
	if (!isRecord(input)) invalidIdentity("identity must be an object");

	const rawMarket = input.market;
	const rawExchange = input.exchange;
	const rawCode = input.code;
	if (
		typeof rawMarket !== "string" ||
		typeof rawExchange !== "string" ||
		typeof rawCode !== "string"
	) {
		invalidIdentity("identity requires market, exchange, and code strings");
	}

	const market = rawMarket.trim().toUpperCase();
	const exchange = rawExchange.trim().toUpperCase();
	const code = rawCode.trim();

	if (exchange === "BJ") {
		throw identityFailure(
			"UNSUPPORTED_EXCHANGE",
			"BJ is not supported by the current QuoteStock contract",
		);
	}
	if (market !== "CN" && market !== "HK") invalidIdentity("market must be CN or HK");
	if (exchange !== "SH" && exchange !== "SZ" && exchange !== "HK")
		invalidIdentity("exchange must be SH, SZ, or HK");
	if ((market === "HK" && exchange !== "HK") || (market === "CN" && exchange === "HK")) {
		invalidIdentity("market and exchange are inconsistent");
	}
	if (market === "CN" && !/^\d{6}$/.test(code))
		invalidIdentity("CN code must be a six-digit string");
	if (market === "HK" && !/^\d{5}$/.test(code))
		invalidIdentity("HK code must be a five-digit string");

	return {
		market: market as CanonicalMarket,
		exchange: exchange as SupportedExchange,
		code,
	};
}

/** Resolve a canonical identity to the Tencent quote symbol. */
export function resolveTencentSymbol(input: unknown): string {
	const identity = canonicalizeIdentity(input);
	return `${identity.exchange.toLowerCase()}${identity.code}`;
}

function identityFromTencentSymbol(symbol: unknown): CanonicalIdentity {
	if (typeof symbol !== "string") {
		throw identityFailure("INVALID_IDENTITY", "Tencent symbol must be a string");
	}
	const normalized = symbol.trim().toLowerCase();
	const match = normalized.match(/^(sh|sz|hk)(\d{5,6})$/);
	if (!match)
		throw identityFailure(
			"INVALID_IDENTITY",
			"Tencent symbol is not a supported SH/SZ/HK symbol",
		);
	const exchange = match[1].toUpperCase();
	const code = match[2];
	return canonicalizeIdentity({
		market: exchange === "HK" ? "HK" : "CN",
		exchange,
		code,
	});
}

function providerNumber(
	value: string,
	field: string,
	identity: CanonicalIdentity,
	symbol: string,
): number {
	const parsed = Number(value);
	if (!value.trim() || !Number.isFinite(parsed)) {
		throw identityFailure(
			"INVALID_PROVIDER_QUOTE",
			`Tencent quote has an invalid ${field}`,
			identity,
			symbol,
		);
	}
	return parsed;
}

function tencentTimeToIso(value: string, identity: CanonicalIdentity, symbol: string): string {
	const compact = value.trim();
	if (/^\d{14}$/.test(compact)) {
		return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}+08:00`;
	}
	const slash = compact.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})$/);
	if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}T${slash[4]}+08:00`;
	throw identityFailure(
		"INVALID_PROVIDER_QUOTE",
		"Tencent quote has an invalid quote time",
		identity,
		symbol,
	);
}

function shanghaiClock(now: Date): { day: string; weekday: number; minutes: number } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(now);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	const weekdays: Record<string, number> = {
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
		Sun: 7,
	};
	return {
		day: `${value("year")}-${value("month")}-${value("day")}`,
		weekday: weekdays[value("weekday")] ?? 0,
		minutes: Number(value("hour")) * 60 + Number(value("minute")),
	};
}

/**
 * Tencent's record type is not an exchange-open flag.  Mark a quote OPEN
 * only when its Beijing trading date matches the current clock and it falls
 * inside that market's regular sessions; stale, holiday, and post-close
 * records remain CLOSED rather than pretending to be real-time.
 */
function inferMarketStatus(
	identity: CanonicalIdentity,
	quoteTime: string,
	now: Date,
): "OPEN" | "CLOSED" {
	const clock = shanghaiClock(now);
	if (clock.weekday < 1 || clock.weekday > 5 || quoteTime.slice(0, 10) !== clock.day) {
		return "CLOSED";
	}
	const sessions =
		identity.market === "HK"
			? [
					[9 * 60 + 30, 12 * 60],
					[13 * 60, 16 * 60],
				]
			: [
					[9 * 60 + 30, 11 * 60 + 30],
					[13 * 60, 15 * 60],
				];
	return sessions.some(([start, end]) => clock.minutes >= start && clock.minutes <= end)
		? "OPEN"
		: "CLOSED";
}

/**
 * Parse one Tencent `qt.gtimg.cn` assignment.  The endpoint is a compact
 * tilde-delimited record; the fields used here are the stable common fields
 * for CN and HK quotes.  `fetchTencentQuote` verifies the requested symbol
 * before calling this parser, so a response for an old/static symbol cannot
 * be silently attached to another active identity.
 */
export function parseTencentQuoteResponse(
	symbol: string,
	body: string,
	now = new Date(),
): ProviderQuote {
	const identity = identityFromTencentSymbol(symbol);
	const canonicalSymbol = resolveTencentSymbol(identity);
	if (typeof body !== "string") {
		throw identityFailure(
			"PROVIDER_UNAVAILABLE",
			"Tencent quote response was not text",
			identity,
			canonicalSymbol,
		);
	}
	const assignment = new RegExp(
		`(?:^|\\r?\\n)\\s*v_${canonicalSymbol}\\s*=\\s*"([^"]*)"\\s*;?`,
		"i",
	).exec(body);
	if (!assignment || !assignment[1]) {
		throw identityFailure(
			"PROVIDER_UNAVAILABLE",
			"Tencent quote response did not contain the requested symbol",
			identity,
			canonicalSymbol,
		);
	}
	const fields = assignment[1].split("~");
	if (fields.length < 35 || fields[2] !== identity.code) {
		throw identityFailure(
			"INVALID_PROVIDER_QUOTE",
			"Tencent quote response has an invalid record",
			identity,
			canonicalSymbol,
		);
	}

	const price = providerNumber(fields[3], "price", identity, canonicalSymbol);
	const preClose = providerNumber(fields[4], "pre_close", identity, canonicalSymbol);
	const open = providerNumber(fields[5], "open", identity, canonicalSymbol);
	const volume = providerNumber(fields[6], "volume", identity, canonicalSymbol);
	const quoteTime = tencentTimeToIso(fields[30], identity, canonicalSymbol);
	// CN field 35 is `price/volume/turnover`; field 8 is only an order-book
	// volume split.  HK publishes turnover directly in field 37.
	const cnTurnover = fields[35]?.split("/")[2];
	const amountField = identity.market === "HK" ? fields[37] : cnTurnover;
	const amount = providerNumber(amountField, "amount", identity, canonicalSymbol);
	const change = providerNumber(fields[31], "change", identity, canonicalSymbol);
	const changePct = providerNumber(fields[32], "change_pct", identity, canonicalSymbol);
	const high = providerNumber(fields[33], "high", identity, canonicalSymbol);
	const low = providerNumber(fields[34], "low", identity, canonicalSymbol);

	return {
		name: fields[1],
		price,
		change,
		change_pct: changePct,
		pre_close: preClose,
		prev_close: preClose,
		open,
		high,
		low,
		pct_change: changePct,
		volume,
		amount,
		market_status: inferMarketStatus(identity, quoteTime, now),
		market_data_time: quoteTime,
		source_update_time: quoteTime,
		quote_time: quoteTime,
		fetch_time: now.toISOString(),
	};
}

/** Fetch one canonical Tencent symbol over the real HTTP endpoint. */
export async function fetchTencentQuote(
	symbol: string,
	options: TencentHttpOptions = {},
): Promise<ProviderQuote> {
	const identity = identityFromTencentSymbol(symbol);
	const canonicalSymbol = resolveTencentSymbol(identity);
	const requestFetch = options.fetchImpl ?? fetch;
	if (typeof requestFetch !== "function") {
		throw identityFailure(
			"PROVIDER_UNAVAILABLE",
			"Tencent quote provider is unavailable",
			identity,
			canonicalSymbol,
		);
	}
	const endpoint = options.endpoint ?? "https://qt.gtimg.cn/q=";
	try {
		const response = await requestFetch(`${endpoint}${encodeURIComponent(canonicalSymbol)}`, {
			headers: { "User-Agent": "QuantPro-Collector/1.0" },
		});
		if (!response.ok) {
			throw identityFailure(
				"PROVIDER_UNAVAILABLE",
				"Tencent quote provider returned an unavailable response",
				identity,
				canonicalSymbol,
			);
		}
		// Tencent returns GBK-family bytes for mainland names.  Decoding bytes
		// explicitly prevents UTF-8 replacement characters in normalized rows.
		const body = new TextDecoder("gb18030").decode(await response.arrayBuffer());
		return parseTencentQuoteResponse(canonicalSymbol, body, options.now ?? new Date());
	} catch (error) {
		if (error instanceof DynamicQuoteError) throw error;
		throw identityFailure(
			"PROVIDER_UNAVAILABLE",
			"Tencent quote provider request failed",
			identity,
			canonicalSymbol,
		);
	}
}

/** Adapt the HTTP fetcher to the `QuoteProvider` seam used by batch fetching. */
export function createTencentQuoteProvider(options: TencentHttpOptions = {}): QuoteProvider {
	return (symbol) => fetchTencentQuote(symbol, options);
}

function finiteField(quote: ProviderQuote, field: string, identity: CanonicalIdentity): number {
	const value = quote[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw identityFailure(
			"INVALID_PROVIDER_QUOTE",
			`provider quote is missing numeric field ${field}`,
			identity,
			resolveTencentSymbol(identity),
		);
	}
	return value;
}

function optionalFiniteField(quote: ProviderQuote, field: string): number | undefined {
	const value = quote[field];
	if (value === undefined || value === null) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeProviderQuote(
	identity: CanonicalIdentity,
	value: unknown,
	now: Date,
): QuoteStock {
	if (value === null || value === undefined) {
		throw identityFailure(
			"PROVIDER_UNAVAILABLE",
			"Tencent quote provider returned no quote",
			identity,
			resolveTencentSymbol(identity),
		);
	}
	if (!isRecord(value)) {
		throw identityFailure(
			"INVALID_PROVIDER_QUOTE",
			"Tencent quote provider returned a non-object quote",
			identity,
			resolveTencentSymbol(identity),
		);
	}

	const quote = value as ProviderQuote;
	const price = finiteField(quote, "price", identity);
	const preClose = finiteField(quote, "pre_close", identity);
	const previousClose = optionalFiniteField(quote, "prev_close") ?? preClose;
	const change = optionalFiniteField(quote, "change") ?? price - preClose;
	const changePct =
		optionalFiniteField(quote, "change_pct") ??
		(preClose === 0 ? 0 : (change / preClose) * 100);
	const open = finiteField(quote, "open", identity);
	const high = finiteField(quote, "high", identity);
	const low = finiteField(quote, "low", identity);
	const pctChange = optionalFiniteField(quote, "pct_change") ?? changePct;
	const volume = finiteField(quote, "volume", identity);
	const amount = finiteField(quote, "amount", identity);
	const marketDataTime = quote.market_data_time;
	if (typeof marketDataTime !== "string" || !marketDataTime.trim()) {
		throw identityFailure(
			"INVALID_PROVIDER_QUOTE",
			"provider quote is missing market_data_time",
			identity,
			resolveTencentSymbol(identity),
		);
	}
	const fetchTime = nonEmptyString(quote.fetch_time, now.toISOString());
	const ageSeconds =
		optionalFiniteField(quote, "age_seconds") ?? deriveAgeSeconds(marketDataTime, fetchTime);
	const marketStatus = quote.market_status === undefined ? "CLOSED" : quote.market_status;
	if (marketStatus !== "OPEN" && marketStatus !== "CLOSED") {
		throw identityFailure(
			"INVALID_PROVIDER_QUOTE",
			"provider quote has an invalid market_status",
			identity,
			resolveTencentSymbol(identity),
		);
	}

	const sourceUpdateTime = nonEmptyString(quote.source_update_time, marketDataTime);
	const quoteTime = nonEmptyString(quote.quote_time, marketDataTime);
	const name = nonEmptyString(quote.name, `${identity.exchange}${identity.code}`);

	return {
		code: identity.code,
		market: identity.market,
		exchange: identity.exchange,
		name,
		// A newly observed LIVE holding reuses the compatibility Watch bucket;
		// its research identity is decided later by the Research registry. It
		// must not be presented as a Core or Growth research conclusion.
		group: "Watch",
		portfolio_group: "watch",
		portfolio_status: "WATCH",
		holding_status: "ACTIVE",
		mapping_only: false,
		mapped_to: null,
		mapping_to: null,
		position_qty: null,
		is_position: true,
		price,
		change,
		change_pct: changePct,
		pre_close: preClose,
		prev_close: previousClose,
		open,
		high,
		low,
		pct_change: pctChange,
		volume,
		amount,
		market_status: marketStatus,
		market_data_time: marketDataTime,
		source_update_time: sourceUpdateTime,
		freshness_basis: "MARKET_DATA",
		quote_time: quoteTime,
		fetch_time: fetchTime,
		age_seconds: ageSeconds,
		primary_source: "tencent",
		secondary_source: null,
		source_status: "OK",
		quality: "LIVE_QUOTE",
	};
}

function deriveAgeSeconds(marketDataTime: string, fetchTime: string): number {
	const marketTimestamp = Date.parse(marketDataTime);
	const fetchTimestamp = Date.parse(fetchTime);
	if (!Number.isFinite(marketTimestamp) || !Number.isFinite(fetchTimestamp)) return 0;
	return Math.max(0, Math.floor((fetchTimestamp - marketTimestamp) / 1000));
}

function asFailure(
	error: unknown,
	identity: CanonicalIdentity,
	symbol: string,
): DynamicQuoteFailure {
	if (error instanceof DynamicQuoteError && error.failures.length > 0) return error.failures[0];
	return {
		identity,
		symbol,
		code: "PROVIDER_UNAVAILABLE",
		message: "Tencent quote provider request failed",
	};
}

function batchErrorCode(failures: DynamicQuoteFailure[], total: number): DynamicQuoteErrorCode {
	if (failures.length < total) return "PARTIAL_PROVIDER_FAILURE";
	if (failures.every((failure) => failure.code === "PROVIDER_UNAVAILABLE"))
		return "PROVIDER_UNAVAILABLE";
	return failures[0]?.code ?? "PROVIDER_UNAVAILABLE";
}

/**
 * Resolve and fetch every active identity atomically.  Promise.allSettled is
 * intentional: a single provider failure is returned with all failed
 * identities, and successful rows are discarded until the complete universe
 * is available.
 */
export async function fetchDynamicQuoteRows(
	inputs: readonly unknown[],
	options: DynamicQuoteFetchOptions,
): Promise<DynamicQuoteBatch> {
	const identities: CanonicalIdentity[] = [];
	const identityFailures: DynamicQuoteFailure[] = [];
	const seen = new Set<string>();
	for (const input of inputs) {
		try {
			const identity = canonicalizeIdentity(input);
			const key = `${identity.market}:${identity.code}`;
			if (seen.has(key)) {
				identityFailures.push({
					identity,
					symbol: resolveTencentSymbol(identity),
					code: "INVALID_IDENTITY",
					message: "duplicate active identity",
				});
				continue;
			}
			seen.add(key);
			identities.push(identity);
		} catch (error) {
			if (error instanceof DynamicQuoteError && error.failures.length > 0) {
				identityFailures.push(...error.failures);
			} else {
				identityFailures.push({
					identity: null,
					symbol: null,
					code: "INVALID_IDENTITY",
					message: "invalid active identity",
				});
			}
		}
	}
	if (identityFailures.length > 0) {
		throw new DynamicQuoteError(
			"INVALID_IDENTITY",
			"active universe contains invalid identities",
			identityFailures,
		);
	}

	const symbols = identities.map(resolveTencentSymbol);
	if (identities.length === 0) return { identities, symbols, rows: [] };
	if (!options || typeof options.fetchQuote !== "function") {
		const failures = identities.map((identity, index) => ({
			identity,
			symbol: symbols[index],
			code: "PROVIDER_UNAVAILABLE" as const,
			message: "Tencent quote provider is unavailable",
		}));
		throw new DynamicQuoteError(
			"PROVIDER_UNAVAILABLE",
			"Tencent quote provider is unavailable",
			failures,
		);
	}

	const now = options.now ?? new Date();
	const settled = await Promise.allSettled(
		identities.map((identity, index) =>
			Promise.resolve().then(() => options.fetchQuote(symbols[index], identity)),
		),
	);
	const rows: QuoteStock[] = [];
	const failures: DynamicQuoteFailure[] = [];
	for (const [index, outcome] of settled.entries()) {
		const identity = identities[index];
		const symbol = symbols[index];
		if (outcome.status === "rejected") {
			failures.push(asFailure(outcome.reason, identity, symbol));
			continue;
		}
		try {
			rows.push(normalizeProviderQuote(identity, outcome.value, now));
		} catch (error) {
			failures.push(asFailure(error, identity, symbol));
		}
	}
	if (failures.length > 0) {
		throw new DynamicQuoteError(
			batchErrorCode(failures, identities.length),
			failures.length === identities.length &&
				failures.every((failure) => failure.code === "PROVIDER_UNAVAILABLE")
				? "Tencent quote provider is unavailable"
				: "Tencent quote provider failed for one or more active identities",
			failures,
		);
	}
	return { identities, symbols, rows };
}

function identityKey(value: Pick<QuoteStock, "market" | "code">): string {
	return `${value.market}:${value.code}`;
}

function toPortfolioUniverseItem(stock: QuoteStock): QuoteSnapshot["portfolio_universe"][number] {
	return {
		code: stock.code,
		market: stock.market,
		exchange: stock.exchange,
		name: stock.name,
		group: stock.group,
		portfolio_group: stock.portfolio_group,
		portfolio_status: stock.portfolio_status,
		holding_status: stock.holding_status,
		mapping_only: stock.mapping_only,
		mapped_to: stock.mapped_to,
		mapping_to: stock.mapping_to,
		position_qty: stock.position_qty,
		is_position: stock.is_position,
	};
}

/**
 * Merge only successful, previously missing active rows.  The input snapshot
 * is never mutated; all existing catalog/research classifications remain
 * untouched, while new rows carry the explicit Watch/unclassified status.
 */
export function mergeDynamicQuoteRows(
	snapshot: QuoteSnapshot,
	batch: DynamicQuoteBatch,
): QuoteSnapshot {
	const existing = new Set(snapshot.stocks.map(identityKey));
	const activeByKey = new Map(
		batch.identities.map((identity) => [`${identity.market}:${identity.code}`, identity]),
	);
	if (activeByKey.size !== batch.identities.length) {
		throw new DynamicQuoteError(
			"PARTIAL_PROVIDER_FAILURE",
			"dynamic quote batch contains duplicate active identities",
			[],
		);
	}
	const additions: QuoteStock[] = [];
	const seenBatch = new Set<string>();

	for (const row of batch.rows) {
		const key = identityKey(row);
		const activeIdentity = activeByKey.get(key);
		if (!activeIdentity || activeIdentity.exchange !== row.exchange) {
			throw new DynamicQuoteError(
				"INVALID_PROVIDER_QUOTE",
				"provider returned a row outside the active universe",
				[
					{
						identity: null,
						symbol: null,
						code: "INVALID_PROVIDER_QUOTE",
						message: "provider returned a row outside the active universe",
					},
				],
			);
		}
		if (seenBatch.has(key)) {
			throw new DynamicQuoteError(
				"INVALID_PROVIDER_QUOTE",
				"provider returned duplicate active rows",
				[
					{
						identity: null,
						symbol: null,
						code: "INVALID_PROVIDER_QUOTE",
						message: "provider returned duplicate active rows",
					},
				],
			);
		}
		seenBatch.add(key);
		if (!existing.has(key)) additions.push(row);
	}
	const missing = batch.identities.filter(
		(identity) => !seenBatch.has(`${identity.market}:${identity.code}`),
	);
	if (missing.length > 0) {
		throw new DynamicQuoteError(
			"PARTIAL_PROVIDER_FAILURE",
			"dynamic quote batch is incomplete",
			missing.map((identity) => ({
				identity,
				symbol: resolveTencentSymbol(identity),
				code: "PARTIAL_PROVIDER_FAILURE" as const,
				message: "missing quote row for active identity",
			})),
		);
	}

	const stocks = [...snapshot.stocks, ...additions];
	const portfolioUniverse = [
		...snapshot.portfolio_universe,
		...additions.map(toPortfolioUniverseItem),
	];
	const provisional = { ...snapshot, stocks, portfolio_universe: portfolioUniverse };
	const counts = getSnapshotCounts(provisional);
	const summary: QuoteSnapshot["summary"] = {
		...snapshot.summary,
		total: counts.total,
		active_quote_total: counts.activeQuoteTotal,
		active_holding_total: counts.activeHoldingTotal,
		watch_total: counts.watchTotal,
		exited_watch_total: counts.exitedWatchTotal,
		mapping_total: counts.mappingTotal,
		core_total: counts.coreTotal,
		growth_total: counts.growthTotal,
	};
	if ("usable" in snapshot.summary) summary.usable = counts.total;

	return { ...provisional, summary };
}
