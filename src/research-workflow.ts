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
import { isFormalResearchOwner } from "./research-scopes.ts";

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
const RECEIPT_CURSOR_V1 = "rcpt1";
const RECEIPT_CURSOR_V2 = "rcpt2";
const RECEIPT_CURSOR_V3 = "rcpt3";
/** Persistent migration epoch from 0007; never derive this at request time. */
const RECEIPT_ORDER_EPOCH = "receipt-order-v3-2026-09-15";

/** §5.6 domain reason closed sets. */
export const CLAIM_REASONS = ["NOT_FOUND", "TERMINAL", "DEFERRED"] as const;
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
	/** Monotonic fencing generation for submit/defer expected_generation. */
	lease_generation: number;
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

export const DEFER_REASONS = [
	"RECHECK_REQUIRED",
	"UPSTREAM_UNAVAILABLE",
	"NEEDS_OWNER_INPUT",
] as const;
export type DeferReason = (typeof DEFER_REASONS)[number];

export type DeferOutcome =
	| { status: "DEFERRED"; job_id: string; recheck_at: string; request_id: string }
	| {
			status: "IDEMPOTENT_REPLAY";
			job_id: string;
			recheck_at: string;
			current_status: "DEFERRED" | "CLAIMED" | "COMPLETED" | "QUEUED";
			request_id: string;
	  }
	| { status: "REJECTED"; job_id: string; reason: SubmitReason; detail: { sub_reason?: LeaseSubReason }; request_id: string };

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

type ReceiptCursor = { receiptSequence: string };

type DeferralRow = {
	job_id: string;
	idempotency_key: string;
	recheck_at: string;
	payload_sha256: string | null;
};

const MAX_D1_RECEIPT_SEQUENCE = 9_223_372_036_854_775_807n;

/** Lossless canonical decimal encoding for a D1 signed 64-bit sequence. */
function receiptSequenceText(value: unknown, allowZero = false): string {
	if (
		typeof value !== "string" ||
		!(allowZero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value)
	) fail("INTEGRITY_FAILED");
	try {
		if (BigInt(value) > MAX_D1_RECEIPT_SEQUENCE) fail("INTEGRITY_FAILED");
		return value;
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		fail("INTEGRITY_FAILED");
	}
}

/** Versioned opaque cursor for 0007's durable receipt ordering epoch. */
function encodeReceiptCursor(receiptSequence: string): string {
	return `${RECEIPT_CURSOR_V3}.${btoa(JSON.stringify({ v: 3, e: RECEIPT_ORDER_EPOCH, s: receiptSequence }))}`;
}

function decodeReceiptCursor(value: string | null | undefined): ReceiptCursor | null {
	if (value === undefined || value === null || value === "") return null;
	if (value.startsWith(`${RECEIPT_CURSOR_V3}.`)) {
		try {
			const parsed = JSON.parse(atob(value.slice(RECEIPT_CURSOR_V3.length + 1)));
			const sequence = isRecord(parsed) ? parsed.s : null;
			if (
				parsed === null ||
				!isRecord(parsed) ||
				parsed.v !== 3 ||
				parsed.e !== RECEIPT_ORDER_EPOCH
			) {
				fail("INTEGRITY_FAILED");
			}
			return { receiptSequence: receiptSequenceText(sequence, true) };
		} catch (error) {
			if (error instanceof ResearchBoundaryError) throw error;
			fail("INTEGRITY_FAILED");
		}
	}
	if (value.startsWith(`${RECEIPT_CURSOR_V2}.`)) {
		// rcpt2 belongs to 0006's old mapping. Never translate its position:
		// every issued rcpt2 replays the new epoch once from sequence zero.
		try {
			const parsed = JSON.parse(atob(value.slice(RECEIPT_CURSOR_V2.length + 1)));
			const sequence = isRecord(parsed) ? parsed.s : null;
			if (parsed === null || !isRecord(parsed) || parsed.v !== 2) fail("INTEGRITY_FAILED");
			receiptSequenceText(sequence);
			return { receiptSequence: "0" };
		} catch (error) {
			if (error instanceof ResearchBoundaryError) throw error;
			fail("INTEGRITY_FAILED");
		}
	}
	if (value.startsWith(`${RECEIPT_CURSOR_V1}.`)) {
		// v1 used (created_at,event_id). Validate it but replay the new epoch
		// from zero so no prior omission becomes permanent.
		try {
			const parsed = JSON.parse(atob(value.slice(RECEIPT_CURSOR_V1.length + 1)));
			if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.t !== "string") fail("INTEGRITY_FAILED");
			normalizedIso(parsed.t, "cursor");
			return { receiptSequence: "0" };
		} catch (error) {
			if (error instanceof ResearchBoundaryError) throw error;
			fail("INTEGRITY_FAILED");
		}
	}
	if (!value.startsWith("rcpt")) {
		// Timestamp-only callers also begin at sequence zero; receipt_id is the
		// stable consumer-side dedupe key for this bounded compatibility replay.
		normalizedIso(value, "since");
		return { receiptSequence: "0" };
	}
	fail("INTEGRITY_FAILED");
}

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
	subReason?: LeaseSubReason | string,
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

async function terminalMatchesProposal(
	db: ResearchWorkflowDatabase,
	jobId: string,
	proposalId: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT job_id FROM research_job_terminal WHERE job_id=? AND proposal_id=?")
		.bind(jobId, proposalId)
		.first<{ job_id: string }>();
	return row !== null;
}

async function selectDeferral(
	db: ResearchWorkflowDatabase,
	jobId: string,
): Promise<DeferralRow | null> {
	return db
		.prepare("SELECT job_id, idempotency_key, recheck_at, payload_sha256 FROM research_job_deferrals WHERE job_id=?")
		.bind(jobId)
		.first<DeferralRow>();
}

async function selectDeferralByIdempotencyKey(
	db: ResearchWorkflowDatabase,
	idempotencyKey: string,
): Promise<DeferralRow | null> {
	return db
		.prepare("SELECT job_id, idempotency_key, recheck_at, payload_sha256 FROM research_job_deferrals WHERE idempotency_key=?")
		.bind(idempotencyKey)
		.first<DeferralRow>();
}

async function deferredCurrentStatus(
	db: ResearchWorkflowDatabase,
	jobId: string,
	now: string,
): Promise<"DEFERRED" | "CLAIMED" | "COMPLETED" | "QUEUED"> {
	if (await selectTerminal(db, jobId)) return "COMPLETED";
	const lease = await selectLease(db, jobId);
	if (lease && lease.lease_expires_at > now) return "CLAIMED";
	const deferral = await selectDeferral(db, jobId);
	if (deferral && deferral.recheck_at > now) return "DEFERRED";
	return "QUEUED";
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
	const activeDeferral = await selectDeferral(db, jobId);
	if (activeDeferral && activeDeferral.recheck_at > now) {
		return { status: "NOT_CLAIMABLE", job_id: jobId, reason: "DEFERRED", request_id: requestId };
	}

	const expiresAt = new Date(Date.parse(now) + RESEARCH_LEASE_TTL_SECONDS * 1000).toISOString();
	// The terminal predicate is inside the same conditional write as lease
	// creation/preemption.  A stale pre-read can therefore never create a live
	// lease after completion has committed.
	const preempt = (claimToken: string) =>
		db
			.prepare(
				"INSERT INTO research_job_leases (job_id, lease_owner, claim_token, claimed_at, lease_expires_at, claim_count) SELECT ?, ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=?) AND NOT EXISTS (SELECT 1 FROM research_job_deferrals WHERE job_id=? AND recheck_at > ?) ON CONFLICT(job_id) DO UPDATE SET lease_owner=excluded.lease_owner, claim_token=excluded.claim_token, claimed_at=excluded.claimed_at, lease_expires_at=excluded.lease_expires_at, claim_count=research_job_leases.claim_count+1 WHERE research_job_leases.lease_expires_at <= ? AND NOT EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=excluded.job_id) AND NOT EXISTS (SELECT 1 FROM research_job_deferrals WHERE job_id=excluded.job_id AND recheck_at > ?)",
			)
			.bind(jobId, leaseOwner, claimToken, now, expiresAt, jobId, jobId, now, now, now);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const claimToken = `clt_${randomHex32()}`;
		// D1 batch is one transaction.  The two audit rows are conditional on
		// the exact transition, so a visible lease transition never commits
		// without its ingress event and no failed preempt mints a receipt.
		const eventId = `evt_${randomHex32()}`;
		const expiredEventId = `evt_${randomHex32()}`;
		await db.batch([
			db
				.prepare(
					"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) SELECT ?, job_id, 'LEASE_EXPIRED', lease_owner, NULL, NULL, '{}', ?, ? FROM research_job_leases WHERE job_id=? AND lease_expires_at <= ? AND NOT EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=research_job_leases.job_id) AND NOT EXISTS (SELECT 1 FROM research_job_deferrals WHERE job_id=research_job_leases.job_id AND recheck_at > ?)",
				)
				.bind(expiredEventId, requestId, now, jobId, now, now),
			preempt(claimToken),
			db
				.prepare(
					"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) SELECT ?, job_id, 'CLAIMED', ?, NULL, NULL, '{}', ?, ? FROM research_job_leases WHERE job_id=? AND lease_owner=? AND claim_token=?",
				)
				.bind(eventId, leaseOwner, requestId, now, jobId, leaseOwner, claimToken),
		] as never);
		// D1's INSERT-trigger UPDATE contributes to meta.changes, so a strict
		// statement-change count is not a transition result. Re-read the
		// committed authoritative lease by its freshly generated capability.
		const lease = await selectLease(db, jobId);
		if (lease && lease.lease_owner === leaseOwner && lease.claim_token === claimToken) {
			return {
				status: "CLAIMED",
				job_id: jobId,
				lease_owner: lease.lease_owner,
				claim_token: lease.claim_token,
				claimed_at: lease.claimed_at,
				lease_expires_at: lease.lease_expires_at,
				claim_count: Number(lease.claim_count),
				lease_generation: Number(lease.claim_count),
				request_id: requestId,
			};
		}
		if (await selectTerminal(db, jobId)) {
			await eventStatement(db, {
				jobId, eventType: "CLAIM_DENIED", actor: leaseOwner, proposalId: null,
				origin: null, detail: eventDetail("TERMINAL"), requestId, createdAt: now,
			}).run();
			return { status: "NOT_CLAIMABLE", job_id: jobId, reason: "TERMINAL", request_id: requestId };
		}
		const deferred = await selectDeferral(db, jobId);
		if (deferred && deferred.recheck_at > now) {
			return { status: "NOT_CLAIMABLE", job_id: jobId, reason: "DEFERRED", request_id: requestId };
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
				lease_generation: Number(current.claim_count),
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
		return resolveProposalRace(db, race);
	}
}

async function resolveProposalRace(
	db: ResearchWorkflowDatabase,
	race: {
		jobId: string;
		idempotencyKey: string;
		prepared: PreparedProposal;
		callerPrincipal: string;
		requestId: string;
		now: string;
	},
): Promise<SubmitOutcome | null> {
	const existing = await selectProposalByIdempotencyKey(db, race.idempotencyKey).catch(() => null);
	if (!existing) return null;
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
		expectedGeneration: number;
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
	if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}
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
	if (!isFormalResearchOwner(callerPrincipal) && declaredOrigin === "CHATGPT") {
		effectiveOrigin = "SYNTHETIC";
	}
	const productionOriginViolation =
		isFormalResearchOwner(callerPrincipal) && declaredOrigin !== "CHATGPT";

	// 3) Structure / size validation failures land as audited REJECTED rows.
	const structureFailed =
		productionOriginViolation ||
		prepared.oversize ||
		prepared.structureError !== null;
	if (structureFailed) {
		const proposalId = `prp_${randomHex32()}`;
		// Issue #19-followup observability: record WHICH structural rule fired
		// (keys / job_binding / recommendation_hint / oversize / ...) in the
		// internal audit event only.  The outward outcome stays
		// REJECTED/VALIDATION_FAILED with an empty detail, and the rcpt3
		// receipt projection whitelists `reason` alone, so the tag never
		// leaves the trust boundary.
		const structureTag = productionOriginViolation
			? `origin_not_chatgpt`
			: prepared.oversize
				? (prepared.structureError ?? `oversize`)
				: (prepared.structureError ?? `structure_invalid`);
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
					detail: eventDetail("VALIDATION_FAILED", structureTag),
					requestId,
					createdAt: now,
				}),
			],
			race,
		);
		if (outcome) return outcome;
		console.log(JSON.stringify({
			event: "research_proposal_validation_failed",
			proposal_id: proposalId,
			job_id: jobId,
			rule: structureTag,
			request_id: requestId,
		}));
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}

	// 4) Lease validation (existence -> expiry -> token -> owner).
	const lease = await selectLease(db, jobId);
	let subReason: LeaseSubReason | null = null;
	if (!lease) subReason = "NO_LEASE";
	else if (lease.lease_expires_at <= now) subReason = "EXPIRED";
	else if (lease.claim_token !== input.claimToken) subReason = "TOKEN_MISMATCH";
	else if (lease.lease_owner !== callerPrincipal) subReason = "OWNER_MISMATCH";
	else if (Number(lease.claim_count) !== input.expectedGeneration) subReason = "TOKEN_MISMATCH";
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
		// Every formal write repeats the exact lease predicate.  This fences an
		// old client that was pre-empted after the earlier read but before this
		// batch began; neither a proposal nor terminal/event can then be left by
		// a stale generation.
		const leasePredicate =
			"EXISTS (SELECT 1 FROM research_job_leases WHERE job_id=? AND lease_owner=? AND claim_token=? AND claim_count=? AND lease_expires_at > ?) AND NOT EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=?)";
		try {
			await db.batch([
				db
					.prepare(
						`INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) SELECT ?, ?, ?, ?, 'CHATGPT', 'RECEIVED', NULL, ?, ?, ?, ? WHERE ${leasePredicate}`,
					)
					.bind(proposalId, jobId, idempotencyKey, callerPrincipal, prepared.payloadJson, prepared.payloadSha256, now, requestId, jobId, callerPrincipal, input.claimToken, input.expectedGeneration, now, jobId),
				db
					.prepare(
						`INSERT INTO research_job_terminal (job_id, terminal_status, proposal_id, completed_at) SELECT ?, 'COMPLETED', ?, ? WHERE ${leasePredicate}`,
					)
					.bind(jobId, proposalId, now, jobId, callerPrincipal, input.claimToken, input.expectedGeneration, now, jobId),
				db
					.prepare("DELETE FROM research_job_leases WHERE job_id=? AND lease_owner=? AND claim_token=? AND claim_count=? AND lease_expires_at > ?")
					.bind(jobId, callerPrincipal, input.claimToken, input.expectedGeneration, now),
				db
					.prepare("INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) SELECT ?, ?, 'SUBMIT_RECEIVED', ?, ?, 'CHATGPT', '{}', ?, ? WHERE EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=? AND proposal_id=?)")
					.bind(`evt_${randomHex32()}`, jobId, callerPrincipal, proposalId, requestId, now, jobId, proposalId),
				db
					.prepare("INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) SELECT ?, ?, 'COMPLETED', ?, ?, 'CHATGPT', '{}', ?, ? WHERE EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=? AND proposal_id=?)")
					.bind(`evt_${randomHex32()}`, jobId, callerPrincipal, proposalId, requestId, now, jobId, proposalId),
			] as never);
		} catch {
			const outcome = await resolveProposalRace(db, race);
			if (outcome) return outcome;
			if (await selectTerminal(db, jobId)) {
				return { status: "REJECTED", job_id: jobId, reason: "SECOND_RESULT", detail: {}, request_id: requestId };
			}
			return { status: "REJECTED", job_id: jobId, reason: "LEASE_INVALID", detail: {}, request_id: requestId };
		}
		// Trigger side effects make D1 meta.changes non-portable. The terminal
		// row plus its idempotency proposal are the authoritative transaction
		// outcome and distinguish a first accepted submit from a later replay.
		const committedProposal = await selectProposalByIdempotencyKey(db, idempotencyKey);
		if (
			committedProposal?.proposal_id === proposalId &&
			committedProposal.status === "RECEIVED" &&
			await terminalMatchesProposal(db, jobId, proposalId)
		) {
			return {
				status: "ACCEPTED",
				job_id: jobId,
				proposal_id: proposalId,
				terminal_status: "COMPLETED",
				request_id: requestId,
			};
		}
		const outcome = await resolveProposalRace(db, race);
		if (outcome) return outcome;
		if (await selectTerminal(db, jobId)) {
			return { status: "REJECTED", job_id: jobId, reason: "SECOND_RESULT", detail: {}, request_id: requestId };
		}
		return { status: "REJECTED", job_id: jobId, reason: "LEASE_INVALID", detail: {}, request_id: requestId };
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
 * Remote defer is the only way an Automation can give a claimed job back
 * before lease expiry.  It is deliberately not a RESEARCH-local transition:
 * the D1 batch writes a durable recheck gate and releases precisely the
 * caller's still-effective fenced lease.  Formal completion remains owned
 * exclusively by submitResearchResultProposal.
 */
export async function deferResearchJob(
	db: ResearchWorkflowDatabase,
	input: {
		jobId: string;
		claimToken: string;
		expectedGeneration: number;
		idempotencyKey: string;
		reason: DeferReason;
		recheckAt: string;
		callerPrincipal: string;
		requestId: string;
		now: string;
	},
): Promise<DeferOutcome> {
	const { jobId, callerPrincipal, requestId } = input;
	if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > RESEARCH_CLAIM_JOB_ID_MAX_LENGTH) fail("FILTERED");
	if (typeof callerPrincipal !== "string" || !callerPrincipal) fail("INTEGRITY_FAILED");
	if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}
	if (typeof input.idempotencyKey !== "string" || !RESEARCH_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}
	if (!(DEFER_REASONS as readonly string[]).includes(input.reason)) {
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}
	const now = normalizedIso(input.now, "now");
	const recheckAt = normalizedIso(input.recheckAt, "recheck_at");
	const payloadSha256 = await sha256Hex(canonicalJson({
		job_id: jobId,
		lease_owner: callerPrincipal,
		claim_token: input.claimToken,
		expected_generation: input.expectedGeneration,
		reason: input.reason,
		recheck_at: recheckAt,
	}));
	const replayOutcome = async (existing: DeferralRow): Promise<DeferOutcome> => {
		if (existing.payload_sha256 !== payloadSha256) {
			return { status: "REJECTED", job_id: jobId, reason: "CONFLICT", detail: {}, request_id: requestId };
		}
		return {
			status: "IDEMPOTENT_REPLAY",
			job_id: jobId,
			recheck_at: existing.recheck_at,
			current_status: await deferredCurrentStatus(db, jobId, now),
			request_id: requestId,
		};
	};
	const sameKey = await selectDeferralByIdempotencyKey(db, input.idempotencyKey);
	if (sameKey) return replayOutcome(sameKey);
	if (recheckAt <= now) {
		return { status: "REJECTED", job_id: jobId, reason: "VALIDATION_FAILED", detail: {}, request_id: requestId };
	}
	if (await selectDeferral(db, jobId)) {
		return { status: "REJECTED", job_id: jobId, reason: "CONFLICT", detail: {}, request_id: requestId };
	}

	// INSERT is conditional on the exact live lease and terminal absence.  It
	// and the fenced release share one D1 transaction, so defer vs submit has
	// a single winner and cannot leave a terminal job with a lease.
	let result: Array<{ meta?: { changes?: number } }>;
	try {
		result = await db.batch([
			db
				.prepare(
					"INSERT INTO research_job_deferrals (job_id, idempotency_key, lease_owner, reason, recheck_at, deferred_at, request_id, payload_sha256, expected_generation) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM research_job_terminal WHERE job_id=?) AND EXISTS (SELECT 1 FROM research_job_leases WHERE job_id=? AND lease_owner=? AND claim_token=? AND claim_count=? AND lease_expires_at > ?)",
				)
				.bind(jobId, input.idempotencyKey, callerPrincipal, input.reason, recheckAt, now, requestId, payloadSha256, input.expectedGeneration, jobId, jobId, callerPrincipal, input.claimToken, input.expectedGeneration, now),
			db
				.prepare("DELETE FROM research_job_leases WHERE job_id=? AND lease_owner=? AND claim_token=? AND claim_count=? AND lease_expires_at > ?")
				.bind(jobId, callerPrincipal, input.claimToken, input.expectedGeneration, now),
		] as never) as Array<{ meta?: { changes?: number } }>;
	} catch {
		const concurrent = await selectDeferralByIdempotencyKey(db, input.idempotencyKey).catch(() => null);
		if (concurrent) return replayOutcome(concurrent);
		fail("STORE_UNAVAILABLE");
	}
	const inserted = Number(result[0]?.meta?.changes ?? 0);
	if (inserted === 1) {
		return { status: "DEFERRED", job_id: jobId, recheck_at: recheckAt, request_id: requestId };
	}
	const replay = await selectDeferralByIdempotencyKey(db, input.idempotencyKey);
	if (replay) return replayOutcome(replay);
	if (await selectDeferral(db, jobId)) return { status: "REJECTED", job_id: jobId, reason: "CONFLICT", detail: {}, request_id: requestId };
	if (await selectTerminal(db, jobId)) return { status: "REJECTED", job_id: jobId, reason: "SECOND_RESULT", detail: {}, request_id: requestId };
	const lease = await selectLease(db, jobId);
	let subReason: LeaseSubReason = "NO_LEASE";
	if (lease && lease.lease_expires_at <= now) subReason = "EXPIRED";
	else if (lease && lease.claim_token !== input.claimToken) subReason = "TOKEN_MISMATCH";
	else if (lease && lease.lease_owner !== callerPrincipal) subReason = "OWNER_MISMATCH";
	else if (lease && Number(lease.claim_count) !== input.expectedGeneration) subReason = "TOKEN_MISMATCH";
	return { status: "REJECTED", job_id: jobId, reason: "LEASE_INVALID", detail: { sub_reason: subReason }, request_id: requestId };
}

/**
 * §5.4 receipts: append-only event stream projected into the fixed
 * collector-receipts-v1 whitelist. rcpt3 pages advance only over migration
 * 0007's persisted event mapping, never client time, random event ids, or
 * 0006's pre-correction ingress sequence. Legacy cursors replay this epoch
 * once from zero; RESEARCH deduplicates that bounded overlap by receipt id.
 */
export async function listResearchJobReceipts(
	db: ResearchWorkflowDatabase,
	input: { since?: string | null; limit?: number; now: string },
): Promise<ResearchReceiptsPage> {
	const generatedAt = normalizedIso(input.now, "now");
	const limit = input.limit ?? RECEIPTS_MAX_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > RECEIPTS_MAX_LIMIT) fail("INTEGRITY_FAILED");
	const cursor = decodeReceiptCursor(input.since);
	try {
		const mappingIntegrity = await db
			.prepare(
				"SELECT (SELECT COUNT(*) FROM research_job_events AS event LEFT JOIN research_receipt_event_order AS receipt_order ON receipt_order.event_id=event.event_id AND receipt_order.epoch=? WHERE receipt_order.event_id IS NULL) AS missing, (SELECT COUNT(*) FROM research_receipt_event_order AS receipt_order LEFT JOIN research_job_events AS event ON event.event_id=receipt_order.event_id WHERE receipt_order.epoch=? AND event.event_id IS NULL) AS orphaned",
			)
			.bind(RECEIPT_ORDER_EPOCH, RECEIPT_ORDER_EPOCH)
			.first<{ missing: number; orphaned: number }>();
		if (
			!mappingIntegrity ||
			Number(mappingIntegrity.missing) !== 0 ||
			Number(mappingIntegrity.orphaned) !== 0
		) fail("STORE_UNAVAILABLE");
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		fail("STORE_UNAVAILABLE");
	}
	const statement = cursor
		? db
				.prepare(
					"SELECT event.event_id, event.job_id, event.event_type, event.actor, event.proposal_id, event.origin, event.detail_json, event.request_id, event.created_at, CAST(receipt_order.receipt_sequence AS TEXT) AS receipt_sequence FROM research_receipt_event_order AS receipt_order JOIN research_job_events AS event ON event.event_id=receipt_order.event_id WHERE receipt_order.epoch=? AND receipt_order.receipt_sequence > CAST(? AS INTEGER) ORDER BY receipt_order.receipt_sequence ASC LIMIT ?",
				)
				.bind(RECEIPT_ORDER_EPOCH, cursor.receiptSequence, limit)
		: db
				.prepare(
					"SELECT event.event_id, event.job_id, event.event_type, event.actor, event.proposal_id, event.origin, event.detail_json, event.request_id, event.created_at, CAST(receipt_order.receipt_sequence AS TEXT) AS receipt_sequence FROM research_receipt_event_order AS receipt_order JOIN research_job_events AS event ON event.event_id=receipt_order.event_id WHERE receipt_order.epoch=? ORDER BY receipt_order.receipt_sequence ASC LIMIT ?",
				)
				.bind(RECEIPT_ORDER_EPOCH, limit);
	let rows: Array<{
		event_id: string;
		job_id: string;
		event_type: string;
		actor: string;
		proposal_id: string | null;
		origin: string | null;
		detail_json: string;
		request_id: string;
		created_at: string;
		receipt_sequence: string;
	}>;
	try {
		rows = (await statement.all<{
			event_id: string;
			job_id: string;
			event_type: string;
			actor: string;
			proposal_id: string | null;
			origin: string | null;
			detail_json: string;
			request_id: string;
			created_at: string;
			receipt_sequence: string;
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
			receipt_id: `rcpt_${(await sha256Hex(row.event_id)).slice(0, 40)}`,
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
	const nextSince = rows.length > 0
		? encodeReceiptCursor(receiptSequenceText(rows[rows.length - 1].receipt_sequence))
		: input.since ?? null;
	return {
		schema_version: RECEIPTS_SCHEMA_VERSION,
		generated_at: generatedAt,
		next_since: nextSince,
		receipts,
	};
}
