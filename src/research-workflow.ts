/**
 * Research work-queue server semantics (2026-09-15 research-backend design
 * §A2/§A3/§5.4/§5.6), implemented as pure logic over an injected D1-shaped
 * database plus injected clock/principal inputs.  No IO of its own: the same
 * module runs against real D1 (worker) and the `node:sqlite` test shim.
 *
 * Server-side job lifecycle (independent from RESEARCH's local five-state
 * model): QUEUED (replica record) -> CLAIMED_BY_CHATGPT (unexpired lease row)
 * -> COMPLETED (terminal row written by an accepted formal proposal).  A
 * lease that expires without a submit lazily returns the job to QUEUED: there
 * is no sweeper, readers decide from the lease expiry timestamp.
 *
 * Storage discipline:
 *   - lease rows only represent the current lease (takeover overwrites;
 *     history lives exclusively in the append-only events table);
 *   - events are append-only at the application level (no UPDATE/DELETE
 *     path exists in this module or anywhere else in the repo);
 *   - `claim_token` is a server-issued capability stored only in the private
 *     lease row.  It never appears in events, receipts, read-plane responses,
 *     logs, or error envelopes.
 */

import { ResearchBoundaryError, assertOutboundV2PayloadSafe } from "./research-outbound-v2.ts";

/** Fixed lease TTL: one fewer adversarial knob; expiry recovery covers budget exhaustion. */
export const RESEARCH_LEASE_TTL_SECONDS = 3600;

/** §A8: claim job_id length bound (overrun -> FILTERED semantics). */
export const RESEARCH_CLAIM_JOB_ID_MAX_LENGTH = 256;

/** §A8: submit proposal JSON serialization byte ceiling (65,536 = 64 KiB). */
export const RESEARCH_PROPOSAL_MAX_BYTES = 65_536;

export const RESEARCH_PROPOSAL_SUMMARY_MAX_CHARS = 4000;
export const RESEARCH_PROPOSAL_FINDINGS_MAX = 50;
export const RESEARCH_PROPOSAL_FINDING_CLAIM_MAX_CHARS = 2000;
export const RESEARCH_PROPOSAL_SOURCES_MAX = 100;
export const RESEARCH_PROPOSAL_SOURCE_MAX_CHARS = 500;

/** §5.3 idempotency key contract. */
export const RESEARCH_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/;

/** §5.4 receipts page ceiling. */
export const RECEIPTS_MAX_LIMIT = 500;
export const RECEIPTS_SCHEMA_VERSION = "collector-receipts-v1";

/**
 * The production client identity that formal (origin=CHATGPT) proposals are
 * anchored to.  It equals the deployed `COLLECTOR_MCP_CLIENT_ID`; local E2E
 * overrides that var with an engineering identity, which is exactly how the
 * server distinguishes shadow (SYNTHETIC) traffic from production clients
 * without trusting any client declaration.
 */
export const RESEARCH_PRODUCTION_PRINCIPAL = "chatgpt-production";

/** §5.6 domain reason closed sets. */
export const CLAIM_REASONS = ["NOT_FOUND", "TERMINAL"] as const;
export const SUBMIT_REASONS = [
	"CONFLICT",
	"SECOND_RESULT",
	"LEASE_INVALID",
	"VALIDATION_FAILED",
] as const;
export const LEASE_SUB_REASONS = [
	"NO_LEASE",
	"EXPIRED",
	"TOKEN_MISMATCH",
	"OWNER_MISMATCH",
] as const;

export type ClaimReason = (typeof CLAIM_REASONS)[number];
export type SubmitReason = (typeof SUBMIT_REASONS)[number];
export type LeaseSubReason = (typeof LEASE_SUB_REASONS)[number];
export type ResearchOrigin = "CHATGPT" | "SYNTHETIC" | "REPLAY";

export type ResearchWorkflowDatabase = Pick<D1Database, "prepare" | "batch">;

type LeaseRow = {
	lease_owner: string;
	claim_token: string;
	claimed_at: string;
	lease_expires_at: string;
	claim_count: number;
};

export type ClaimClaimed = {
	status: "CLAIMED";
	job_id: string;
	lease_owner: string;
	claim_token: string;
	claimed_at: string;
	lease_expires_at: string;
	claim_count: number;
	request_id: string;
};

export type ClaimAlreadyClaimed = {
	status: "ALREADY_CLAIMED";
	job_id: string;
	lease_owner: string;
	lease_expires_at: string;
	request_id: string;
};

export type ClaimNotClaimable = {
	status: "NOT_CLAIMABLE";
	job_id: string;
	reason: ClaimReason;
	request_id: string;
};

export type ClaimOutcome = ClaimClaimed | ClaimAlreadyClaimed | ClaimNotClaimable;

export type SubmitAccepted = {
	status: "ACCEPTED";
	job_id: string;
	proposal_id: string;
	terminal_status: "COMPLETED";
	request_id: string;
};

export type SubmitAcceptedSynthetic = {
	status: "ACCEPTED_SYNTHETIC";
	job_id: string;
	proposal_id: string;
	job_status: "QUEUED";
	request_id: string;
};

export type SubmitIdempotentReplay = {
	status: "IDEMPOTENT_REPLAY";
	job_id: string;
	proposal_id: string;
	original_created_at: string;
	request_id: string;
};

export type SubmitRejected = {
	status: "REJECTED";
	job_id: string;
	reason: SubmitReason;
	detail: { sub_reason?: LeaseSubReason };
	request_id: string;
};

export type SubmitOutcome =
	| SubmitAccepted
	| SubmitAcceptedSynthetic
	| SubmitIdempotentReplay
	| SubmitRejected;

export type ResearchReceiptItem = {
	receipt_id: string;
	job_id: string;
	event_type: string;
	occurred_at: string;
	actor: string;
	proposal_id: string | null;
	origin: string | null;
	request_id: string;
	detail: { reason: string | null };
};

export type ResearchReceiptsPage = {
	schema_version: typeof RECEIPTS_SCHEMA_VERSION;
	generated_at: string;
	next_since: string | null;
	receipts: ResearchReceiptItem[];
};

function fail(errorCode: "FILTERED" | "STORE_UNAVAILABLE" | "INTEGRITY_FAILED"): never {
	throw new ResearchBoundaryError(errorCode);
}

function randomHex32(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deterministic JSON used for payload hashing and audit storage. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizedIso(value: string, field: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		fail("INTEGRITY_FAILED");
	}
	return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Event detail values are a closed set (§5.6): a reason code, an optional
 * lease sub-reason, nothing else.  Client input, tokens, and payload
 * fragments are structurally impossible here.
 */
function eventDetail(
	reason: SubmitReason | ClaimReason | null,
	subReason?: LeaseSubReason,
): Record<string, unknown> {
	if (reason === null) return {};
	return subReason === undefined ? { reason } : { reason, sub_reason: subReason };
}

function eventStatement(
	db: ResearchWorkflowDatabase,
	input: {
		jobId: string;
		eventType: string;
		actor: string;
		proposalId: string | null;
		origin: ResearchOrigin | null;
		detail: Record<string, unknown>;
		requestId: string;
		createdAt: string;
	},
) {
	return db
		.prepare(
			"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			`evt_${randomHex32()}`,
			input.jobId,
			input.eventType,
			input.actor,
			input.proposalId,
			input.origin,
			JSON.stringify(input.detail),
			input.requestId,
			input.createdAt,
		);
}

async function selectLease(
	db: ResearchWorkflowDatabase,
	jobId: string,
): Promise<LeaseRow | null> {
	return db
		.prepare(
			"SELECT lease_owner, claim_token, claimed_at, lease_expires_at, claim_count FROM research_job_leases WHERE job_id=?",
		)
		.bind(jobId)
		.first<LeaseRow>();
}

async function selectTerminal(db: ResearchWorkflowDatabase, jobId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT job_id FROM research_job_terminal WHERE job_id=?")
		.bind(jobId)
		.first<{ job_id: string }>();
	return row !== null;
}

/**
 * §A2 claim: single-owner conditional atomic preemption with fixed TTL,
 * lazy expiry recovery, same-owner idempotent re-claim, and a PRIVATE/
 * nonexistent NOT_FOUND that provides no existence oracle.
 */
export async function claimResearchJob(
	db: ResearchWorkflowDatabase,
	input: { jobId: string; leaseOwner: string; requestId: string; now: string },
): Promise<ClaimOutcome> {
	const { jobId, leaseOwner, requestId } = input;
	if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > RESEARCH_CLAIM_JOB_ID_MAX_LENGTH) {
		fail("FILTERED");
	}
	if (typeof leaseOwner !== "string" || !leaseOwner) fail("INTEGRITY_FAILED");
	const now = normalizedIso(input.now, "now");

	// Visibility gate: only PUBLIC job records are claimable this round.
	const record = await db
		.prepare(
			"SELECT record_key FROM research_records WHERE record_type='job' AND record_key=? AND visibility='PUBLIC' LIMIT 1",
		)
		.bind(jobId)
		.first<{ record_key: string }>();
	if (!record) return { status: "NOT_CLAIMABLE", job_id: jobId, reason: "NOT_FOUND", request_id: requestId };

	if (await selectTerminal(db, jobId)) {
		// CLAIM_DENIED is only audited for a real job whose lifecycle was
		// denied by its terminal state; NOT_FOUND claims are not recorded at
		// all so arbitrary ids cannot mint receipt rows.
		await eventStatement(db, {
			jobId,
			eventType: "CLAIM_DENIED",
			actor: leaseOwner,
			proposalId: null,
			origin: null,
			detail: eventDetail("TERMINAL"),
			requestId,
			createdAt: now,
		}).run();
		return { status: "NOT_CLAIMABLE", job_id: jobId, reason: "TERMINAL", request_id: requestId };
	}

	const expiresAt = new Date(Date.parse(now) + RESEARCH_LEASE_TTL_SECONDS * 1000).toISOString();
	// §A2 atomic preemption, verbatim.  D1/SQLite write serialization makes
	// the conditional upsert the final arbiter under concurrency.
	const preempt = () =>
		db
			.prepare(
				"INSERT INTO research_job_leases (job_id, lease_owner, claim_token, claimed_at, lease_expires_at, claim_count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(job_id) DO UPDATE SET lease_owner=excluded.lease_owner, claim_token=excluded.claim_token, claimed_at=excluded.claimed_at, lease_expires_at=excluded.lease_expires_at, claim_count=research_job_leases.claim_count+1 WHERE research_job_leases.lease_expires_at <= ?",
			)
			.bind(jobId, leaseOwner, `clt_${randomHex32()}`, now, expiresAt, now)
			.run();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const prior = await selectLease(db, jobId);
		const result = await preempt();
		if (Number(result.meta.changes ?? 0) === 1) {
			if (prior && prior.lease_expires_at <= now) {
				// The superseded lease expired without a submit: audit it before
				// the new CLAIMED so the event stream reads chronologically.
				await eventStatement(db, {
					jobId,
					eventType: "LEASE_EXPIRED",
					actor: prior.lease_owner,
					proposalId: null,
					origin: null,
					detail: eventDetail(null),
					requestId,
					createdAt: now,
				}).run();
			}
			await eventStatement(db, {
				jobId,
				eventType: "CLAIMED",
				actor: leaseOwner,
				proposalId: null,
				origin: null,
				detail: eventDetail(null),
				requestId,
				createdAt: now,
			}).run();
			const lease = await selectLease(db, jobId);
			if (!lease) fail("STORE_UNAVAILABLE");
			return {
				status: "CLAIMED",
				job_id: jobId,
				lease_owner: lease.lease_owner,
				claim_token: lease.claim_token,
				claimed_at: lease.claimed_at,
				lease_expires_at: lease.lease_expires_at,
				claim_count: Number(lease.claim_count),
				request_id: requestId,
			};
		}
		const current = await selectLease(db, jobId);
		if (!current || current.lease_expires_at <= now) continue; // raced; retry once
		if (current.lease_owner === leaseOwner) {
			// Same-owner idempotent re-claim: original lease verbatim, no event.
			return {
				status: "CLAIMED",
				job_id: jobId,
				lease_owner: current.lease_owner,
				claim_token: current.claim_token,
				claimed_at: current.claimed_at,
				lease_expires_at: current.lease_expires_at,
				claim_count: Number(current.claim_count),
				request_id: requestId,
			};
		}
		return {
			status: "ALREADY_CLAIMED",
			job_id: jobId,
			lease_owner: current.lease_owner,
			lease_expires_at: current.lease_expires_at,
			request_id: requestId,
		};
	}
	fail("STORE_UNAVAILABLE");
}

type ProposalFinding = {
	claim: unknown;
	evidence_ids: unknown;
	confidence: unknown;
	counter_evidence: unknown;
};

const PROPOSAL_REQUIRED_KEYS = [
	"job_id",
	"summary",
	"findings",
	"recommendation_hint",
	"sources_consulted",
	"completed_at",
] as const;
const PROPOSAL_OPTIONAL_KEYS = ["tokens_used"] as const;
const PROPOSAL_FINDING_KEYS = ["claim", "evidence_ids", "confidence", "counter_evidence"] as const;
const PROPOSAL_HINTS = new Set([
	"NONE",
	"THESIS_REVIEW",
	"COUNTER_EVIDENCE_FOUND",
	"NO_SECOND_SOURCE",
	"INSUFFICIENT_DATA",
]);
const PROPOSAL_CONFIDENCES = new Set(["HIGH", "MEDIUM", "LOW"]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function boundedText(value: unknown, max: number, allowEmpty = false): boolean {
	if (typeof value !== "string") return false;
	if (!allowEmpty && value.length < 1) return false;
	return value.length <= max;
}

function isParseableIso(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * §5.5 exact-keys structural validation.  Semantics (thesis quality, #2/#3
 * eligibility) are Validator territory (#16) and deliberately out of scope.
 * Returns null when valid, otherwise a short structural violation tag.
 */
function validateProposalStructure(proposal: unknown, jobId: string): string | null {
	if (!isRecord(proposal)) return "not_object";
	const keys = Object.keys(proposal);
	const requiredMissing = PROPOSAL_REQUIRED_KEYS.some((key) => !(key in proposal));
	const unknownKeys = keys.filter(
		(key) =>
			!(PROPOSAL_REQUIRED_KEYS as readonly string[]).includes(key) &&
			!(PROPOSAL_OPTIONAL_KEYS as readonly string[]).includes(key),
	);
	if (requiredMissing || unknownKeys.length > 0) return "keys";
	if (proposal.job_id !== jobId) return "job_binding";
	if (!boundedText(proposal.summary, RESEARCH_PROPOSAL_SUMMARY_MAX_CHARS)) return "summary";
	if (!Array.isArray(proposal.findings) || proposal.findings.length > RESEARCH_PROPOSAL_FINDINGS_MAX) {
		return "findings";
	}
	for (const finding of proposal.findings) {
		if (!isRecord(finding) || !exactKeys(finding, PROPOSAL_FINDING_KEYS)) return "finding_keys";
		const typed = finding as unknown as ProposalFinding;
		if (!boundedText(typed.claim, RESEARCH_PROPOSAL_FINDING_CLAIM_MAX_CHARS, true)) return "finding_claim";
		if (!Array.isArray(typed.evidence_ids) || typed.evidence_ids.some((id) => typeof id !== "string" || !id)) {
			return "finding_evidence_ids";
		}
		if (typeof typed.confidence !== "string" || !PROPOSAL_CONFIDENCES.has(typed.confidence)) {
			return "finding_confidence";
		}
		if (typed.counter_evidence !== null && !boundedText(typed.counter_evidence, RESEARCH_PROPOSAL_FINDING_CLAIM_MAX_CHARS, true)) {
			return "finding_counter_evidence";
		}
	}
	if (typeof proposal.recommendation_hint !== "string" || !PROPOSAL_HINTS.has(proposal.recommendation_hint)) {
		return "recommendation_hint";
	}
	if (
		!Array.isArray(proposal.sources_consulted) ||
		proposal.sources_consulted.length > RESEARCH_PROPOSAL_SOURCES_MAX ||
		proposal.sources_consulted.some(
			(source) => !boundedText(source, RESEARCH_PROPOSAL_SOURCE_MAX_CHARS, true),
		)
	) {
		return "sources_consulted";
	}
	if (
		"tokens_used" in proposal &&
		(typeof proposal.tokens_used !== "number" ||
			!Number.isInteger(proposal.tokens_used) ||
			proposal.tokens_used < 0)
	) {
		return "tokens_used";
	}
	if (!isParseableIso(proposal.completed_at)) return "completed_at";
	return null;
}

type PreparedProposal = {
	payloadJson: string;
	payloadSha256: string;
	oversize: boolean;
	structureError: string | null;
};

type ExistingProposalRow = {
	proposal_id: string;
	status: string;
	payload_sha256: string;
	created_at: string;
	reject_reason: string | null;
};

async function selectProposalByIdempotencyKey(
	db: ResearchWorkflowDatabase,
	idempotencyKey: string,
): Promise<ExistingProposalRow | null> {
	return db
		.prepare(
			"SELECT proposal_id, status, payload_sha256, created_at, reject_reason FROM research_proposals WHERE idempotency_key=?",
		)
		.bind(idempotencyKey)
		.first<ExistingProposalRow>();
}

/**
 * Verdict for a duplicated idempotency key (§A3): same-key same-payload
 * replays the original outcome without new rows; same-key different-payload
 * is CONFLICT (the UNIQUE constraint is the database backstop).
 */
function outcomeForExistingProposal(
	existing: ExistingProposalRow,
	jobId: string,
	prepared: PreparedProposal,
	requestId: string,
): SubmitOutcome | "CONFLICT" {
	if (existing.payload_sha256 === prepared.payloadSha256) {
		if (existing.status === "RECEIVED") {
			return {
				status: "IDEMPOTENT_REPLAY",
				job_id: jobId,
				proposal_id: existing.proposal_id,
				original_created_at: existing.created_at,
				request_id: requestId,
			};
		}
		const reason = (existing.reject_reason ?? "VALIDATION_FAILED") as SubmitReason;
		return { status: "REJECTED", job_id: jobId, reason, detail: {}, request_id: requestId };
	}
	return "CONFLICT";
}

async function writeConflictEvent(
	db: ResearchWorkflowDatabase,
	input: {
		jobId: string;
		existingProposalId: string;
		callerPrincipal: string;
		requestId: string;
		now: string;
	},
): Promise<void> {
	await eventStatement(db, {
		jobId: input.jobId,
		eventType: "SUBMIT_CONFLICT",
		actor: input.callerPrincipal,
		proposalId: input.existingProposalId,
		origin: null,
		detail: eventDetail("CONFLICT"),
		requestId: input.requestId,
		createdAt: input.now,
	}).run();
}

/**
 * Run a proposal-mutating batch.  On a storage failure the idempotency row is
 * re-read: if a concurrent writer won the UNIQUE race the submission is
 * resolved as its replay/conflict verdict instead of a synthetic 5xx.
 */
async function runProposalBatch(
	db: ResearchWorkflowDatabase,
	statements: unknown[],
	race: {
		jobId: string;
		idempotencyKey: string;
		prepared: PreparedProposal;
		callerPrincipal: string;
		requestId: string;
		now: string;
	},
): Promise<SubmitOutcome | null> {
	try {
		await db.batch(statements as never);
		return null;
	} catch {
		const existing = await selectProposalByIdempotencyKey(db, race.idempotencyKey).catch(
			() => null,
		);
		if (!existing) fail("STORE_UNAVAILABLE");
		const verdict = outcomeForExistingProposal(existing, race.jobId, race.prepared, race.requestId);
		if (verdict === "CONFLICT") {
			await writeConflictEvent(db, {
				jobId: race.jobId,
				existingProposalId: existing.proposal_id,
				callerPrincipal: race.callerPrincipal,
				requestId: race.requestId,
				now: race.now,
			}).catch(() => fail("STORE_UNAVAILABLE"));
			return { status: "REJECTED", job_id: race.jobId, reason: "CONFLICT", detail: {}, request_id: race.requestId };
		}
		return verdict;
	}
}

async function prepareProposal(proposal: unknown, jobId: string): Promise<PreparedProposal> {
	const structureError = validateProposalStructure(proposal, jobId);
	// Same hidden-key + path scanning discipline as the outbound boundary.
	try {
		assertOutboundV2PayloadSafe(proposal);
	} catch {
		return { payloadJson: "{}", payloadSha256: await sha256Hex("{}"), oversize: false, structureError: "unsafe_payload" };
	}
	const payloadJson = canonicalJson(proposal);
	const bytes = new TextEncoder().encode(payloadJson).byteLength;
	if (bytes > RESEARCH_PROPOSAL_MAX_BYTES) {
		// The audit row never carries the oversized body: the 64 KiB ceiling
		// stays a real bound even on the rejection path.
		return { payloadJson: "{}", payloadSha256: await sha256Hex("{}"), oversize: true, structureError };
	}
	return { payloadJson, payloadSha256: await sha256Hex(payloadJson), oversize: false, structureError };
}

/**
 * §A3 submit-as-complete: structural validation, job binding, idempotent
 * replay, adversarial audit storage, receipts, and the one-formal-result
 * guarantee backed by the partial unique index.  SYNTHETIC/REPLAY proposals
 * are stored and receipted but never complete a job; the lease is consumed
 * and released so the job returns to QUEUED.
 */
export async function submitResearchResultProposal(
	db: ResearchWorkflowDatabase,
	input: {
		jobId: string;
		claimToken: string;
		idempotencyKey: string;
		origin?: string;
		proposal: unknown;
		callerPrincipal: string;
		requestId: string;
		now: string;
	},
): Promise<SubmitOutcome> {
	const { jobId, callerPrincipal, requestId } = input;
	if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > RESEARCH_CLAIM_JOB_ID_MAX_LENGTH) {
		fail("FILTERED");
	}
	if (typeof callerPrincipal !== "string" || !callerPrincipal) fail("INTEGRITY_FAILED");
	const now = normalizedIso(input.now, "now");
	const idempotencyKey = input.idempotencyKey;
	if (typeof idempotencyKey !== "string" || !RESEARCH_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
		// A malformed key cannot safely anchor an audit row or event; the
		// domain rejection is returned directly (nothing is persisted).
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}

	const prepared = await prepareProposal(input.proposal, jobId);

	// 1) Idempotency first: a retry of an accepted submit must replay even
	// though the accept path already deleted the lease.
	const existing = await selectProposalByIdempotencyKey(db, idempotencyKey);
	if (existing) {
		const verdict = outcomeForExistingProposal(existing, jobId, prepared, requestId);
		if (verdict === "CONFLICT") {
			await writeConflictEvent(db, {
				jobId,
				existingProposalId: existing.proposal_id,
				callerPrincipal,
				requestId,
				now,
			});
			return { status: "REJECTED", job_id: jobId, reason: "CONFLICT", detail: {}, request_id: requestId };
		}
		return verdict;
	}
	const race = { jobId, idempotencyKey, prepared, callerPrincipal, requestId, now };

	// 2) Origin enforcement (server-side, not client-honored).  Non-production
	// principals can never file a formal result: CHATGPT is downgraded.
	const declaredOrigin: ResearchOrigin =
		input.origin === undefined ? "CHATGPT" : (input.origin as ResearchOrigin);
	if (
		declaredOrigin !== "CHATGPT" &&
		declaredOrigin !== "SYNTHETIC" &&
		declaredOrigin !== "REPLAY"
	) {
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}
	let effectiveOrigin: ResearchOrigin = declaredOrigin;
	if (callerPrincipal !== RESEARCH_PRODUCTION_PRINCIPAL && declaredOrigin === "CHATGPT") {
		effectiveOrigin = "SYNTHETIC";
	}
	const productionOriginViolation =
		callerPrincipal === RESEARCH_PRODUCTION_PRINCIPAL && declaredOrigin !== "CHATGPT";

	// 3) Structure / size validation failures land as audited REJECTED rows.
	const structureFailed =
		productionOriginViolation ||
		prepared.oversize ||
		prepared.structureError !== null;
	if (structureFailed) {
		const proposalId = `prp_${randomHex32()}`;
		const outcome = await runProposalBatch(
			db,
			[
				db
					.prepare(
						"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES (?, ?, ?, ?, ?, 'REJECTED', 'VALIDATION_FAILED', ?, ?, ?, ?)",
					)
					.bind(
						proposalId,
						jobId,
						idempotencyKey,
						callerPrincipal,
						effectiveOrigin,
						prepared.payloadJson,
						prepared.payloadSha256,
						now,
						requestId,
					),
				eventStatement(db, {
					jobId,
					eventType: "SUBMIT_REJECTED",
					actor: callerPrincipal,
					proposalId,
					origin: effectiveOrigin,
					detail: eventDetail("VALIDATION_FAILED"),
					requestId,
					createdAt: now,
				}),
			],
			race,
		);
		if (outcome) return outcome;
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}

	// 4) Lease validation (existence -> expiry -> token -> owner).
	const lease = await selectLease(db, jobId);
	let subReason: LeaseSubReason | null = null;
	if (!lease) subReason = "NO_LEASE";
	else if (lease.lease_expires_at <= now) subReason = "EXPIRED";
	else if (lease.claim_token !== input.claimToken) subReason = "TOKEN_MISMATCH";
	else if (lease.lease_owner !== callerPrincipal) subReason = "OWNER_MISMATCH";
	if (subReason !== null) {
		const proposalId = `prp_${randomHex32()}`;
		const outcome = await runProposalBatch(
			db,
			[
				db
					.prepare(
						"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES (?, ?, ?, ?, ?, 'REJECTED', 'LEASE_INVALID', ?, ?, ?, ?)",
					)
					.bind(
						proposalId,
						jobId,
						idempotencyKey,
						callerPrincipal,
						effectiveOrigin,
						prepared.payloadJson,
						prepared.payloadSha256,
						now,
						requestId,
					),
				eventStatement(db, {
					jobId,
					eventType: "SUBMIT_REJECTED",
					actor: callerPrincipal,
					proposalId,
					origin: effectiveOrigin,
					detail: eventDetail("LEASE_INVALID", subReason),
					requestId,
					createdAt: now,
				}),
			],
			race,
		);
		if (outcome) return outcome;
		return {
			status: "REJECTED",
			job_id: jobId,
			reason: "LEASE_INVALID",
			detail: { sub_reason: subReason },
			request_id: requestId,
		};
	}

	// 5) One formal result per job (application check; the partial unique
	// index is the database-level backstop).
	if (effectiveOrigin === "CHATGPT") {
		const formal = await db
			.prepare(
				"SELECT proposal_id FROM research_proposals WHERE job_id=? AND origin='CHATGPT' AND status='RECEIVED' LIMIT 1",
			)
			.bind(jobId)
			.first<{ proposal_id: string }>();
		if (formal) {
			const proposalId = `prp_${randomHex32()}`;
			const outcome = await runProposalBatch(
				db,
				[
					db
						.prepare(
							"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES (?, ?, ?, ?, 'CHATGPT', 'REJECTED', 'SECOND_RESULT', ?, ?, ?, ?)",
						)
						.bind(
							proposalId,
							jobId,
							idempotencyKey,
							callerPrincipal,
							prepared.payloadJson,
							prepared.payloadSha256,
							now,
							requestId,
						),
					eventStatement(db, {
						jobId,
						eventType: "SUBMIT_REJECTED",
						actor: callerPrincipal,
						proposalId,
						origin: "CHATGPT",
						detail: eventDetail("SECOND_RESULT"),
						requestId,
						createdAt: now,
					}),
				],
				race,
			);
			if (outcome) return outcome;
			return { status: "REJECTED", job_id: jobId, reason: "SECOND_RESULT", detail: {}, request_id: requestId };
		}
	}

	// 6) Accept.  Formal: proposal + terminal + lease release + two events in
	// one atomic batch.  Synthetic: proposal + lease release + one event; the
	// job stays QUEUED and can be re-claimed.
	const proposalId = `prp_${randomHex32()}`;
	const proposalInsert = db
		.prepare(
			"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES (?, ?, ?, ?, ?, 'RECEIVED', NULL, ?, ?, ?, ?)",
		)
		.bind(
			proposalId,
			jobId,
			idempotencyKey,
			callerPrincipal,
			effectiveOrigin,
			prepared.payloadJson,
			prepared.payloadSha256,
			now,
			requestId,
		);
	const leaseRelease = db.prepare("DELETE FROM research_job_leases WHERE job_id=?").bind(jobId);
	const receivedEvent = eventStatement(db, {
		jobId,
		eventType: "SUBMIT_RECEIVED",
		actor: callerPrincipal,
		proposalId,
		origin: effectiveOrigin,
		detail: eventDetail(null),
		requestId,
		createdAt: now,
	});
	if (effectiveOrigin === "CHATGPT") {
		const outcome = await runProposalBatch(
			db,
			[
				proposalInsert,
				db
					.prepare(
						"INSERT INTO research_job_terminal (job_id, terminal_status, proposal_id, completed_at) VALUES (?, 'COMPLETED', ?, ?)",
					)
					.bind(jobId, proposalId, now),
				leaseRelease,
				receivedEvent,
				eventStatement(db, {
					jobId,
					eventType: "COMPLETED",
					actor: callerPrincipal,
					proposalId,
					origin: effectiveOrigin,
					detail: eventDetail(null),
					requestId,
					createdAt: now,
				}),
			],
			race,
		);
		if (outcome) return outcome;
		return {
			status: "ACCEPTED",
			job_id: jobId,
			proposal_id: proposalId,
			terminal_status: "COMPLETED",
			request_id: requestId,
		};
	}
	const outcome = await runProposalBatch(
		db,
		[proposalInsert, leaseRelease, receivedEvent],
		race,
	);
	if (outcome) return outcome;
	return {
		status: "ACCEPTED_SYNTHETIC",
		job_id: jobId,
		proposal_id: proposalId,
		job_status: "QUEUED",
		request_id: requestId,
	};
}

/**
 * §5.4 receipts: append-only event stream projected into the fixed
 * collector-receipts-v1 whitelist.  `since` replays closed-interval on
 * created_at (overlap is absorbed downstream by the RESEARCH-side UNIQUE
 * dedupe).  `claim_token`, proposal payloads, and client input are
 * structurally absent from the projection.
 */
export async function listResearchJobReceipts(
	db: ResearchWorkflowDatabase,
	input: { since?: string | null; limit?: number; now: string },
): Promise<ResearchReceiptsPage> {
	const generatedAt = normalizedIso(input.now, "now");
	const limit = input.limit ?? RECEIPTS_MAX_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > RECEIPTS_MAX_LIMIT) fail("INTEGRITY_FAILED");
	let since: string | null = null;
	if (input.since !== undefined && input.since !== null && input.since !== "") {
		since = normalizedIso(input.since, "since");
	}
	const statement = since
		? db
				.prepare(
					"SELECT job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at FROM research_job_events WHERE created_at >= ? ORDER BY created_at ASC, event_id ASC LIMIT ?",
				)
				.bind(since, limit)
		: db
				.prepare(
					"SELECT job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at FROM research_job_events ORDER BY created_at ASC, event_id ASC LIMIT ?",
				)
				.bind(limit);
	let rows: Array<{
		job_id: string;
		event_type: string;
		actor: string;
		proposal_id: string | null;
		origin: string | null;
		detail_json: string;
		request_id: string;
		created_at: string;
	}>;
	try {
		rows = (await statement.all<{
			job_id: string;
			event_type: string;
			actor: string;
			proposal_id: string | null;
			origin: string | null;
			detail_json: string;
			request_id: string;
			created_at: string;
		}>()).results ?? [];
	} catch {
		fail("STORE_UNAVAILABLE");
	}
	const receipts: ResearchReceiptItem[] = [];
	for (const row of rows) {
		let reason: string | null = null;
		try {
			const parsed = JSON.parse(row.detail_json) as { reason?: unknown };
			if (typeof parsed?.reason === "string") reason = parsed.reason;
		} catch {
			reason = null;
		}
		receipts.push({
			receipt_id: `rcpt_${(await sha256Hex(`${row.job_id}|${row.event_type}|${row.created_at}|${row.request_id}`)).slice(0, 40)}`,
			job_id: row.job_id,
			event_type: row.event_type,
			occurred_at: row.created_at,
			actor: row.actor,
			proposal_id: row.proposal_id,
			origin: row.origin,
			request_id: row.request_id,
			detail: { reason },
		});
	}
	const nextSince = receipts.length > 0 ? receipts[receipts.length - 1].occurred_at : since;
	return {
		schema_version: RECEIPTS_SCHEMA_VERSION,
		generated_at: generatedAt,
		next_since: nextSince,
		receipts,
	};
}
