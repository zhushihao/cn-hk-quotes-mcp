/**
 * Adversarial work-queue semantics over the REAL 0001-0004 DDL executed by
 * the node:sqlite shim (#5 research-backend design §6: B1-B6, B9, B11, B12).
 *
 * All data is synthetic; no fixture bytes are mutated (v3 fixtures are only
 * read for realistic job envelopes).  The database-level guarantees under
 * test: conditional-upsert atomic preemption, the partial unique index
 * `research_proposals_one_formal`, batch atomicity, and the append-only
 * event stream.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createResearchWorkflowDb, createSharedPair } from "./helpers/d1-sqlite-shim.mjs";

const workflow = await import("../src/research-workflow.ts");
const replica = await import("../src/research-replica.ts");
const outbound = await import("../src/research-outbound-v2.ts");
const adapterMod = await import("../src/research-remote-adapter.ts");

// Synthetic values matching the current derived stable-owner shape returned by
// formalResearchOwner(); the domain receives the derived owner, never a DCR
// client id or a model-ferried claim token.
const PRODUCTION = `oauth-client:${"a".repeat(64)}`;
const ENGINEERING = "chatgpt-engineering";

class FakeR2 {
	objects = new Map();
	async put(key, body, options) {
		this.objects.set(key, { body, options });
	}
}

function freshStorage() {
	return { db: createResearchWorkflowDb(), objects: new FakeR2() };
}

function nowIso(offsetMs = 0) {
	// Anchor to the real clock: the read adapter derives server_state from the
	// wall clock, so injected workflow times must be comparable with it.
	return new Date(Date.now() + offsetMs).toISOString();
}

async function ingestJob(
	storage,
	jobId,
	{
		visibility = "PUBLIC",
		generatedAt = "2026-09-15T00:00:00+00:00",
		updatedAt = "2026-09-15T00:00:00+00:00",
	} = {},
) {
	const payload = {
		job_id: jobId,
		dedupe_key: `dedupe-${jobId}`,
		status: "QUEUED",
		priority: 2,
		theme: "synthetic-theme",
		company: null,
		question: "synthetic research question",
		missing_dimensions_json: '["M"]',
		counter_evidence_request: null,
		accumulator_snapshot_id: "snap-synthetic-1",
		coverage_gap_json: { missing: ["M"] },
		priority_reason: "synthetic gap",
		deadline: null,
		recheck_at: null,
		budget_hint: null,
		historical_backfill: false,
		created_at: "2026-09-15T00:00:00+00:00",
		updated_at: updatedAt,
		policy_version: "collector-policy-v1",
		visibility,
		trigger_evidence_ids: ["ev-synthetic-1", "ev-synthetic-2"],
	};
	const record = {
		record_type: "job",
		message_id: "pending",
		schema_version: "collector-outbound-v3",
		policy_version: "collector-policy-v1",
		visibility,
		payload,
		generated_at: generatedAt,
	};
	record.message_id = await outbound.computeOutboundV2MessageId(record);
	return replica.ingestResearchReplicaRecord(storage, record, null, generatedAt);
}

function proposal(jobId, summary = "synthetic summary") {
	return {
		job_id: jobId,
		summary,
		findings: [
			{
				claim: "synthetic claim with synthetic evidence",
				evidence_ids: ["ev-synthetic-1"],
				confidence: "MEDIUM",
				counter_evidence: null,
			},
		],
		recommendation_hint: "NONE",
		sources_consulted: ["synthetic-source-a"],
		tokens_used: 10,
		completed_at: "2026-09-15T10:00:00+00:00",
	};
}

async function claim(storage, jobId, owner, when, { db } = {}) {
	return workflow.claimResearchJob(db ?? storage.db, {
		jobId,
		leaseOwner: owner,
		requestId: `req-${owner}-${Math.random().toString(16).slice(2, 10)}`,
		now: when,
	});
}

async function submit(
	storage,
	jobId,
	owner,
	expectedGeneration,
	idempotencyKey,
	proposalPayload,
	when,
	{ origin = "CHATGPT", db } = {},
) {
	return workflow.submitResearchResultProposal(db ?? storage.db, {
		jobId,
		expectedGeneration,
		idempotencyKey,
		origin,
		proposal: proposalPayload,
		callerPrincipal: owner,
		requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
		now: when,
	});
}

async function eventRows(db, jobId) {
	const result = await db
		.prepare(
			"SELECT event_type, actor, detail_json FROM research_job_events WHERE job_id=? ORDER BY created_at ASC, event_id ASC",
		)
		.bind(jobId)
		.all();
	return result.results;
}

async function countEvents(db, jobId, eventType) {
	const rows = await eventRows(db, jobId);
	return rows.filter((row) => row.event_type === eventType).length;
}

test("B1 concurrent double-claim yields exactly one CLAIMED", async () => {
	const pair = createSharedPair();
	try {
		await ingestJob({ db: pair.connections[0], objects: new FakeR2() }, "job-b1");
		const when = nowIso();
		// Both clients observe the empty state before either write lands; the
		// conditional upsert is the sole arbiter (deterministic interleaving).
		const [a, b] = await Promise.all([
			claim({ db: pair.connections[0] }, "job-b1", "client-a", when),
			claim({ db: pair.connections[1] }, "job-b1", "client-b", when),
		]);
		const outcomes = [a.status, b.status].sort();
		assert.deepEqual(outcomes, ["ALREADY_CLAIMED", "CLAIMED"]);
		const winner = a.status === "CLAIMED" ? a : b;
		const loser = a.status === "CLAIMED" ? b : a;
		// The loser learns only the winner's non-sensitive owner name and expiry.
		assert.equal(loser.lease_owner, winner.lease_owner);
		assert.equal(loser.lease_expires_at, winner.lease_expires_at);
		assert.equal(Object.keys(loser).includes("claim_token"), false);
		const leaseRows = await pair.connections[0]
			.prepare("SELECT job_id, claim_count FROM research_job_leases")
			.all();
		assert.equal(leaseRows.results.length, 1);
		assert.equal(leaseRows.results[0].claim_count, 1);
		assert.equal(leaseRows.results[0].job_id, "job-b1");
		// Exactly one CLAIMED event; the loser is not recorded as CLAIM_DENIED
		// (already-claimed is a routine race outcome, not a lifecycle denial).
		assert.equal(await countEvents(pair.connections[0], "job-b1", "CLAIMED"), 1);
		assert.equal(await countEvents(pair.connections[0], "job-b1", "CLAIM_DENIED"), 0);
	} finally {
		pair.dispose();
	}
});

test("B2 claim same-owner retry returns the original lease generation", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b2");
	const when = nowIso();
	const first = await claim(storage, "job-b2", ENGINEERING, when);
	assert.equal(first.status, "CLAIMED");
	const retry = await claim(storage, "job-b2", ENGINEERING, nowIso(5_000));
	assert.equal(retry.status, "CLAIMED");
	assert.equal(retry.lease_generation, first.lease_generation);
	assert.equal(retry.claimed_at, first.claimed_at);
	assert.equal(retry.lease_expires_at, first.lease_expires_at);
	assert.equal(retry.claim_count, 1);
	assert.equal(await countEvents(storage.db, "job-b2", "CLAIMED"), 1);
});

test("B3 expired lease takeover fences the old owner and generation", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b3");
	const stale = await claim(storage, "job-b3", "client-a", nowIso(-7_200_000));
	assert.equal(stale.status, "CLAIMED");
	const takeover = await claim(storage, "job-b3", "client-b", nowIso());
	assert.equal(takeover.status, "CLAIMED");
	assert.notEqual(takeover.lease_generation, stale.lease_generation);
	assert.equal(takeover.claim_count, 2);
	const events = await eventRows(storage.db, "job-b3");
	// Initial CLAIMED, then the takeover batch: one LEASE_EXPIRED for the
	// superseded lease plus one CLAIMED.  Both takeover events share the same
	// created_at by design, so only their multiset is deterministic here.
	assert.deepEqual(events.map((row) => row.event_type).sort(), [
		"CLAIMED",
		"CLAIMED",
		"LEASE_EXPIRED",
	]);
	const expiredEvents = events.filter((row) => row.event_type === "LEASE_EXPIRED");
	assert.equal(expiredEvents.length, 1);
	assert.equal(expiredEvents[0].actor, "client-a");
	// The stale owner is fenced: submit with the old owner/generation pair hits
	// OWNER_MISMATCH and is audited as REJECTED without occupying the formal slot.
	const verdict = await submit(
		storage,
		"job-b3",
		"client-a",
		stale.lease_generation,
		"key-b3-stale",
		proposal("job-b3"),
		nowIso(),
	);
	assert.equal(verdict.status, "REJECTED");
	assert.equal(verdict.reason, "LEASE_INVALID");
	assert.equal(verdict.detail.sub_reason, "OWNER_MISMATCH");
	const rejected = await storage.db
		.prepare("SELECT status, reject_reason FROM research_proposals WHERE job_id='job-b3'")
		.all();
	assert.equal(rejected.results.length, 1);
	assert.equal(rejected.results[0].status, "REJECTED");
	// client-b's valid lease is untouched by the rejected submit.
	const reSubmit = await submit(
		storage,
		"job-b3",
		"client-b",
		takeover.lease_generation,
		"key-b3-fresh",
		proposal("job-b3"),
		nowIso(),
		{ origin: "SYNTHETIC" },
	);
	assert.equal(reSubmit.status, "ACCEPTED_SYNTHETIC");
});

test("B4 claimed job abandoned returns to QUEUED and context stays intact", async () => {
	const storage = freshStorage();
	// Fixture-derived job with trigger evidence (v3 payload).
	const fixtureJob = JSON.parse(
		readFileSync(
			new URL(
				"./fixtures/outbound_v3/metadata_job.queued.trigger_evidence.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	await replica.ingestResearchReplicaRecord(
		storage,
		fixtureJob[0],
		null,
		"2026-09-15T03:00:00+00:00",
	);
	const jobId = fixtureJob[0].payload.job_id;
	const abandoned = await claim(storage, jobId, "client-a", nowIso(-7_200_000));
	assert.equal(abandoned.status, "CLAIMED");

	const adapter = new adapterMod.CollectorResearchRemoteAdapter(storage, {
		visibility: "PUBLIC",
	});
	const jobsAfterExpiry = await adapter.listResearchJobs(50, { claimableOnly: true });
	assert.ok(jobsAfterExpiry.some((job) => job.record_key === jobId));
	assert.equal(
		jobsAfterExpiry.find((job) => job.record_key === jobId).server_state.effective_status,
		"QUEUED",
	);

	const reclaimed = await claim(storage, jobId, PRODUCTION, nowIso());
	assert.equal(reclaimed.status, "CLAIMED");
	const context = await adapter.getResearchJobContext(jobId);
	assert.equal(context.server_state.effective_status, "CLAIMED");
	assert.equal(context.server_state.lease_owner, PRODUCTION);
	assert.deepEqual(context.payload.trigger_evidence_ids, ["ev-fixture-0001", "ev-fixture-0002"]);
	assert.deepEqual(context.proposals, []);
	const accepted = await submit(
		storage,
		jobId,
		PRODUCTION,
		reclaimed.lease_generation,
		"key-b4-formal",
		proposal(jobId),
		nowIso(),
	);
	assert.equal(accepted.status, "ACCEPTED");
	assert.equal(accepted.terminal_status, "COMPLETED");
});

test("B5 completed job rejects further claims and submits", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b5");
	const lease = await claim(storage, "job-b5", PRODUCTION, nowIso(-1_000));
	const accepted = await submit(
		storage,
		"job-b5",
		PRODUCTION,
		lease.lease_generation,
		"key-b5-formal",
		proposal("job-b5"),
		nowIso(),
	);
	assert.equal(accepted.status, "ACCEPTED");
	// claim after terminal -> NOT_CLAIMABLE/TERMINAL + CLAIM_DENIED audit.
	const lateClaim = await claim(storage, "job-b5", ENGINEERING, nowIso());
	assert.deepEqual(lateClaim, {
		status: "NOT_CLAIMABLE",
		job_id: "job-b5",
		reason: "TERMINAL",
		request_id: lateClaim.request_id,
	});
	assert.equal(await countEvents(storage.db, "job-b5", "CLAIM_DENIED"), 1);
	// Unknown jobs must not become an existence oracle.
	const ghostClaim = await claim(storage, "job-never-ingested", ENGINEERING, nowIso());
	assert.equal(ghostClaim.reason, "NOT_FOUND");
	assert.equal(await countEvents(storage.db, "job-never-ingested", "CLAIM_DENIED"), 0);
	// A second formal result behind a (re-created, defense-in-depth) lease is
	// rejected as SECOND_RESULT and audited without touching the terminal row.
	await storage.db
		.prepare(
			"INSERT INTO research_job_leases (job_id, lease_owner, claim_token, claimed_at, lease_expires_at, claim_count) VALUES ('job-b5', ?, ?, ?, ?, 1)",
		)
		.bind(PRODUCTION, "clt_" + "b".repeat(32), nowIso(-1_000), nowIso(3_600_000))
		.run();
	const second = await submit(
		storage,
		"job-b5",
		PRODUCTION,
		1,
		"key-b5-second",
		proposal("job-b5", "second attempt"),
		nowIso(),
	);
	assert.equal(second.status, "REJECTED");
	assert.equal(second.reason, "SECOND_RESULT");
	const terminal = await storage.db
		.prepare("SELECT terminal_status FROM research_job_terminal WHERE job_id='job-b5'")
		.all();
	assert.equal(terminal.results.length, 1);
	assert.equal(await countEvents(storage.db, "job-b5", "SUBMIT_REJECTED"), 1);
});

test("B6 submit idempotent replay / conflict / second result and index backstop", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b6");
	const lease = await claim(storage, "job-b6", PRODUCTION, nowIso());
	const first = await submit(
		storage,
		"job-b6",
		PRODUCTION,
		lease.lease_generation,
		"key-b6-formal",
		proposal("job-b6"),
		nowIso(),
	);
	assert.equal(first.status, "ACCEPTED");

	// Same key + same payload -> replay of the original outcome; no new rows.
	const replay = await submit(
		storage,
		"job-b6",
		PRODUCTION,
		lease.lease_generation,
		"key-b6-formal",
		proposal("job-b6"),
		nowIso(),
	);
	assert.equal(replay.status, "IDEMPOTENT_REPLAY");
	assert.equal(replay.proposal_id, first.proposal_id);
	const proposalRows = await storage.db
		.prepare("SELECT proposal_id FROM research_proposals WHERE job_id='job-b6'")
		.all();
	assert.equal(proposalRows.results.length, 1);
	const eventsBeforeConflict = await (
		await storage.db
			.prepare(
				"SELECT COUNT(*) AS n FROM research_job_events WHERE job_id='job-b6' AND event_type='SUBMIT_CONFLICT'",
			)
			.all()
	).results;
	assert.equal(eventsBeforeConflict[0].n, 0);

	// Same key + different payload -> CONFLICT, event only, rows unchanged.
	const conflict = await submit(
		storage,
		"job-b6",
		PRODUCTION,
		lease.lease_generation,
		"key-b6-formal",
		proposal("job-b6", "different payload"),
		nowIso(),
	);
	assert.equal(conflict.status, "REJECTED");
	assert.equal(conflict.reason, "CONFLICT");
	assert.equal(
		(
			await storage.db
				.prepare("SELECT COUNT(*) AS n FROM research_proposals WHERE job_id='job-b6'")
				.all()
		).results[0].n,
		1,
	);
	assert.equal(await countEvents(storage.db, "job-b6", "SUBMIT_CONFLICT"), 1);

	// One formal result is a DATABASE guarantee: a direct INSERT bypassing all
	// application checks still violates the partial unique index.
	await ingestJob(storage, "job-b6-index");
	// First formal RECEIVED row for the job -> allowed.
	await storage.db
		.prepare(
			"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES ('prp-x1', 'job-b6-index', 'key-x1', ?, 'CHATGPT', 'RECEIVED', NULL, '{}', 'x', ?, ?)",
		)
		.bind(PRODUCTION, nowIso(), "req-x1")
		.run();
	// REJECTED rows do not occupy the formal slot...
	await storage.db
		.prepare(
			"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES ('prp-x2', 'job-b6-index', 'key-x2', ?, 'CHATGPT', 'REJECTED', 'LEASE_INVALID', '{}', 'x', ?, ?)",
		)
		.bind(PRODUCTION, nowIso(), "req-x2")
		.run();
	// ...but a second RECEIVED formal row does, regardless of proposal id.
	await assert.rejects(() =>
		storage.db
			.prepare(
				"INSERT INTO research_proposals (proposal_id, job_id, idempotency_key, caller_principal, origin, status, reject_reason, payload_json, payload_sha256, created_at, request_id) VALUES ('prp-x3', 'job-b6-index', 'key-x3', ?, 'CHATGPT', 'RECEIVED', NULL, '{}', 'x', ?, ?)",
			)
			.bind(PRODUCTION, nowIso(), "req-x3")
			.run(),
	);
});

test("B9 inbound job republish never touches lease or terminal", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b9");
	const lease = await claim(storage, "job-b9", ENGINEERING, nowIso());
	assert.equal(lease.status, "CLAIMED");
	// Re-publish the QUEUED job: a fresh projection carries a bumped payload
	// updated_at, hence a new-generation message_id (not a transport REPLAY).
	const republished = await ingestJob(storage, "job-b9", {
		generatedAt: "2026-09-15T09:00:00+00:00",
		updatedAt: "2026-09-15T09:00:00+00:00",
	});
	assert.equal(republished.status, "APPLIED");
	const leaseRow = await storage.db
		.prepare("SELECT lease_owner, claim_count FROM research_job_leases WHERE job_id='job-b9'")
		.first();
	assert.equal(leaseRow.lease_owner, ENGINEERING);
	assert.equal(leaseRow.claim_count, lease.lease_generation);

	// Complete formally, then republish again: terminal wins over inbound.
	const accepted = await submit(
		storage,
		"job-b9",
		ENGINEERING,
		lease.lease_generation,
		"key-b9-synth",
		proposal("job-b9"),
		nowIso(),
		{ origin: "REPLAY" },
	);
	assert.equal(accepted.status, "ACCEPTED_SYNTHETIC");
	const formalLease = await claim(storage, "job-b9", PRODUCTION, nowIso(1_000));
	assert.equal(formalLease.status, "CLAIMED");
	const formal = await submit(
		storage,
		"job-b9",
		PRODUCTION,
		formalLease.lease_generation,
		"key-b9-formal",
		proposal("job-b9"),
		nowIso(2_000),
	);
	assert.equal(formal.status, "ACCEPTED");
	await ingestJob(storage, "job-b9", {
		generatedAt: "2026-09-15T09:30:00+00:00",
		updatedAt: "2026-09-15T09:30:00+00:00",
	});
	const terminal = await storage.db
		.prepare("SELECT terminal_status FROM research_job_terminal WHERE job_id='job-b9'")
		.all();
	assert.equal(terminal.results.length, 1);
	const lateClaim = await claim(storage, "job-b9", ENGINEERING, nowIso(3_000));
	assert.equal(lateClaim.reason, "TERMINAL");
	const adapter = new adapterMod.CollectorResearchRemoteAdapter(storage, {
		visibility: "PUBLIC",
	});
	const context = await adapter.getResearchJobContext("job-b9");
	assert.equal(context.server_state.effective_status, "COMPLETED");
	assert.equal(context.proposals.length, 2);
});

test("B12 synthetic submit stored but never completes job; origin forge downgraded", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b12-synth");
	const lease = await claim(storage, "job-b12-synth", ENGINEERING, nowIso());
	// Engineering declares SYNTHETIC explicitly -> stored, receipted, isolated.
	const synthetic = await submit(
		storage,
		"job-b12-synth",
		ENGINEERING,
		lease.lease_generation,
		"key-b12-synth",
		proposal("job-b12-synth"),
		nowIso(),
		{ origin: "SYNTHETIC" },
	);
	assert.equal(synthetic.status, "ACCEPTED_SYNTHETIC");
	assert.equal(synthetic.job_status, "QUEUED");
	const terminalRows = await storage.db.prepare("SELECT job_id FROM research_job_terminal").all();
	assert.equal(terminalRows.results.length, 0);
	// Lease was consumed and released: the job is claimable again immediately.
	const reClaim = await claim(storage, "job-b12-synth", "client-b", nowIso(1_000));
	assert.equal(reClaim.status, "CLAIMED");
	const stored = await storage.db
		.prepare("SELECT origin, status FROM research_proposals WHERE job_id='job-b12-synth'")
		.first();
	assert.equal(stored.origin, "SYNTHETIC");
	assert.equal(stored.status, "RECEIVED");
	assert.equal(await countEvents(storage.db, "job-b12-synth", "SUBMIT_RECEIVED"), 1);

	// Non-production principal declaring CHATGPT is silently downgraded to
	// SYNTHETIC storage (§A3): accepted, receipted, but it can never occupy
	// the formal slot or complete the job.
	const forge = await submit(
		storage,
		"job-b12-synth",
		"client-b",
		reClaim.lease_generation,
		"key-b12-forge",
		proposal("job-b12-synth"),
		nowIso(2_000),
		{ origin: "CHATGPT" },
	);
	assert.equal(forge.status, "ACCEPTED_SYNTHETIC");
	const forgeRow = await storage.db
		.prepare(
			"SELECT origin, status, reject_reason FROM research_proposals WHERE idempotency_key='key-b12-forge'",
		)
		.first();
	assert.equal(forgeRow.origin, "SYNTHETIC");
	assert.equal(forgeRow.status, "RECEIVED");
	assert.equal(forgeRow.reject_reason, null);
	assert.equal(
		(await storage.db.prepare("SELECT job_id FROM research_job_terminal").all()).results.length,
		0,
	);

	// The production principal itself cannot file shadow traffic: declaring
	// SYNTHETIC/REPLAY from the production identity is VALIDATION_FAILED.
	const prodLease = await claim(storage, "job-b12-synth", PRODUCTION, nowIso(3_000));
	assert.equal(prodLease.status, "CLAIMED");
	const prodShadow = await submit(
		storage,
		"job-b12-synth",
		PRODUCTION,
		prodLease.lease_generation,
		"key-b12-shadow",
		proposal("job-b12-synth"),
		nowIso(4_000),
		{ origin: "SYNTHETIC" },
	);
	assert.equal(prodShadow.status, "REJECTED");
	assert.equal(prodShadow.reason, "VALIDATION_FAILED");

	// ...and the formal path stays open afterwards (shadow never consumed it).
	const formal = await submit(
		storage,
		"job-b12-synth",
		PRODUCTION,
		prodLease.lease_generation,
		"key-b12-formal",
		proposal("job-b12-synth"),
		nowIso(5_000),
	);
	assert.equal(formal.status, "ACCEPTED");
	assert.equal(
		(
			await storage.db
				.prepare("SELECT job_id FROM research_job_terminal WHERE job_id='job-b12-synth'")
				.all()
		).results.length,
		1,
	);
});

test("B11 submit 64 KiB / field-level ceilings and claim id bound", async () => {
	const storage = freshStorage();
	await ingestJob(storage, "job-b11");
	const lease = await claim(storage, "job-b11", PRODUCTION, nowIso());

	// Serialized proposal above 64 KiB -> VALIDATION_FAILED; the audit row
	// never carries the oversized body.
	const oversized = proposal("job-b11", "x".repeat(65_537));
	const oversizeVerdict = await submit(
		storage,
		"job-b11",
		PRODUCTION,
		lease.lease_generation,
		"key-b11-oversize",
		oversized,
		nowIso(),
	);
	assert.equal(oversizeVerdict.status, "REJECTED");
	assert.equal(oversizeVerdict.reason, "VALIDATION_FAILED");
	const oversizeRow = await storage.db
		.prepare(
			"SELECT payload_json FROM research_proposals WHERE idempotency_key='key-b11-oversize'",
		)
		.first();
	assert.equal(oversizeRow.payload_json, "{}");

	// Field-level caps: summary > 4000, 51 findings, claim > 2000, source > 500
	// chars / 101 sources, bad idempotency key format.
	const tooManyFindings = proposal("job-b11");
	tooManyFindings.findings = Array.from({ length: 51 }, () => tooManyFindings.findings[0]);
	for (const [key, mutate] of [
		["key-b11-summary", (p) => (p.summary = "x".repeat(4001))],
		["key-b11-findings", (p) => (p.findings = tooManyFindings.findings)],
		["key-b11-claim", (p) => (p.findings[0].claim = "x".repeat(2001))],
		["key-b11-source", (p) => (p.sources_consulted = ["x".repeat(501)])],
		["key-b11-sources", (p) => (p.sources_consulted = Array.from({ length: 101 }, () => "s"))],
		["key-b11-hint", (p) => (p.recommendation_hint = "NOT_A_HINT")],
		["key-b11-completed", (p) => (p.completed_at = "not-a-date")],
		["key-b11-extra", (p) => (p.extra_key = 1)],
	]) {
		const payload = proposal("job-b11");
		mutate(payload);
		const verdict = await submit(
			storage,
			"job-b11",
			PRODUCTION,
			lease.lease_generation,
			key,
			payload,
			nowIso(),
		);
		assert.equal(verdict.status, "REJECTED", key);
		assert.equal(verdict.reason, "VALIDATION_FAILED", key);
	}
	// Malformed idempotency key: rejected before any persistence.
	const badKey = await submit(
		storage,
		"job-b11",
		PRODUCTION,
		lease.lease_generation,
		"short",
		proposal("job-b11"),
		nowIso(),
	);
	assert.equal(badKey.status, "REJECTED");
	assert.equal(badKey.reason, "VALIDATION_FAILED");
	assert.equal(
		(
			await storage.db
				.prepare(
					"SELECT COUNT(*) AS n FROM research_proposals WHERE idempotency_key='short'",
				)
				.all()
		).results[0].n,
		0,
	);
	// The lease survived all rejected submits; the formal path still completes.
	const formal = await submit(
		storage,
		"job-b11",
		PRODUCTION,
		lease.lease_generation,
		"key-b11-formal",
		proposal("job-b11"),
		nowIso(),
	);
	assert.equal(formal.status, "ACCEPTED");
	// claim job_id over 256 chars -> FILTERED boundary error.
	await assert.rejects(
		() => claim(storage, "j".repeat(257), PRODUCTION, nowIso()),
		(error) => error?.error_code === "FILTERED",
	);
});
