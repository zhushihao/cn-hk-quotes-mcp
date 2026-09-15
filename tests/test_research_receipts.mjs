/**
 * Route-level receipts endpoint tests (#5 research-backend design §A1/§5.4,
 * matrix B13) plus the ingest 2 MiB body gate (§A8, route half of B11),
 * driven through worker.fetch per the research-replica test precedent.
 *
 * The database behind the routes is the real 0001-0004 DDL on the node:sqlite
 * shim; events are seeded through the real workflow module.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import path from "node:path";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Let the default resolver report the original error for non-TS imports.
			}
		}
		return nextResolve(specifier, context);
	},
});

const worker = (await import("../src/index.ts")).default;
const workflow = await import("../src/research-workflow.ts");
const { createResearchWorkflowDb } = await import("./helpers/d1-sqlite-shim.mjs");

const INGEST_TOKEN = "local-ingest-token";
const PRODUCTION = `oauth-client:${"a".repeat(64)}`;
const RECEIPTS_URL = "https://worker.example/internal/research-replica/v2/receipts";
const INGEST_URL = "https://worker.example/internal/research-replica/v2/ingest";

function env({ withTransportToken = true } = {}) {
	return {
		RESEARCH_REPLICA: createResearchWorkflowDb(),
		RESEARCH_OBJECTS: { async put() {} },
		...(withTransportToken ? { RESEARCH_REPLICA_INGEST_TOKEN: INGEST_TOKEN } : {}),
	};
}

async function seedLifecycle(envObject, jobId, when) {
	const db = envObject.RESEARCH_REPLICA;
	// Staggered timestamps make the (created_at, event_id) cursor order
	// deterministic across the lifecycle.
	const at = (seconds) => new Date(Date.parse(when) + seconds * 1000).toISOString();
	// A lifecycle with claim, synthetic receipt, conflict, and completion so
	// every receipt event type has a representative.
	await db
		.prepare(
			"INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at) VALUES ('job', ?, ?, 'PUBLIC', 'collector-outbound-v3', '{}', ?, ?)",
		)
		.bind(jobId, `msg-${jobId}`, when, when)
		.run();
	const claim = await workflow.claimResearchJob(db, {
		jobId,
		leaseOwner: "client-a",
		requestId: `req-${jobId}-claim`,
		now: at(0),
	});
	assert.equal(claim.status, "CLAIMED");
	const proposal = {
		job_id: jobId,
		summary: "synthetic",
		findings: [],
		recommendation_hint: "NONE",
		sources_consulted: [],
		completed_at: when,
	};
	const synthetic = await workflow.submitResearchResultProposal(db, {
		jobId,
		claimToken: claim.claim_token,
		expectedGeneration: claim.lease_generation,
		idempotencyKey: `key-${jobId}-synth`,
		origin: "SYNTHETIC",
		proposal,
		callerPrincipal: "client-a",
		requestId: `req-${jobId}-synth`,
		now: at(10),
	});
	assert.equal(synthetic.status, "ACCEPTED_SYNTHETIC");
	// A conflict: same idempotency key, different payload.
	const conflict = await workflow.submitResearchResultProposal(db, {
		jobId,
		claimToken: "clt_" + "0".repeat(32),
		expectedGeneration: claim.lease_generation,
		idempotencyKey: `key-${jobId}-synth`,
		origin: "SYNTHETIC",
		proposal: { ...proposal, summary: "different" },
		callerPrincipal: "client-a",
		requestId: `req-${jobId}-conflict`,
		now: at(20),
	});
	assert.equal(conflict.reason, "CONFLICT");
	// Formal completion by the production principal.
	const formalClaim = await workflow.claimResearchJob(db, {
		jobId,
		leaseOwner: PRODUCTION,
		requestId: `req-${jobId}-claim2`,
		now: at(30),
	});
	assert.equal(formalClaim.status, "CLAIMED");
	const formal = await workflow.submitResearchResultProposal(db, {
		jobId,
		claimToken: formalClaim.claim_token,
		expectedGeneration: formalClaim.lease_generation,
		idempotencyKey: `key-${jobId}-formal`,
		proposal,
		callerPrincipal: PRODUCTION,
		requestId: `req-${jobId}-formal`,
		now: at(40),
	});
	assert.equal(formal.status, "ACCEPTED");
}

test("B13 receipts endpoint shares the RESEARCH transport token and fails closed when it is absent (503)", async () => {
	const envObject = env({ withTransportToken: false });
	const response = await worker.fetch(
		new Request(RECEIPTS_URL, { headers: { Authorization: `Bearer ${INGEST_TOKEN}` } }),
		envObject,
		{},
	);
	assert.equal(response.status, 503);
	const body = await response.json();
	assert.equal(body.error_code, "STORE_UNAVAILABLE");
});

test("B13 receipts endpoint rejects a wrong or missing token (401) and non-GET (405)", async () => {
	const envObject = env();
	for (const init of [{ headers: { Authorization: "Bearer wrong-token" } }, { headers: {} }]) {
		const response = await worker.fetch(new Request(RECEIPTS_URL, init), envObject, {});
		assert.equal(response.status, 401);
		assert.equal((await response.json()).error_code, "FILTERED");
	}
	const post = await worker.fetch(
		new Request(RECEIPTS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${INGEST_TOKEN}` },
		}),
		envObject,
		{},
	);
	assert.equal(post.status, 405);
});

test("B13 receipts endpoint validates since/limit bounds (400)", async () => {
	const envObject = env();
	for (const query of ["limit=0", "limit=501", "limit=abc", "since=not-a-date"]) {
		const response = await worker.fetch(
			new Request(`${RECEIPTS_URL}?${query}`, {
				headers: { Authorization: `Bearer ${INGEST_TOKEN}` },
			}),
			envObject,
			{},
		);
		assert.equal(response.status, 400, query);
		assert.equal((await response.json()).error_code, "INTEGRITY_FAILED", query);
	}
});

test("B13 receipts page is the fixed whitelist with no claim_token or payload", async () => {
	const envObject = env();
	await seedLifecycle(envObject, "job-b13-1", "2026-09-15T08:00:00.000Z");
	const response = await worker.fetch(
		new Request(RECEIPTS_URL, { headers: { Authorization: `Bearer ${INGEST_TOKEN}` } }),
		envObject,
		{},
	);
	assert.equal(response.status, 200);
	const page = await response.json();
	assert.equal(page.schema_version, "collector-receipts-v1");
	assert.equal(typeof page.generated_at, "string");
	const types = page.receipts.map((receipt) => receipt.event_type).sort();
	assert.deepEqual(types, [
		"CLAIMED",
		"CLAIMED",
		"COMPLETED",
		"SUBMIT_CONFLICT",
		"SUBMIT_RECEIVED",
		"SUBMIT_RECEIVED",
	]);
	const whitelist = [
		"receipt_id",
		"job_id",
		"event_type",
		"occurred_at",
		"actor",
		"proposal_id",
		"origin",
		"request_id",
		"detail",
	].sort();
	for (const receipt of page.receipts) {
		assert.deepEqual(Object.keys(receipt).sort(), whitelist);
		assert.match(receipt.receipt_id, /^rcpt_[0-9a-f]{40}$/);
		assert.deepEqual(Object.keys(receipt.detail), ["reason"]);
		if (receipt.event_type === "SUBMIT_CONFLICT")
			assert.equal(receipt.detail.reason, "CONFLICT");
	}
	// The claim token never leaves the lease row: no clt_ capability anywhere.
	assert.equal(JSON.stringify(page).includes("clt_"), false);
	// Proposal payloads never surface: only ids/enums.
	assert.equal(JSON.stringify(page).includes("synthetic"), false);
	assert.equal(typeof page.next_since, "string");
});

test("B13 rcpt3 cursor is monotonic and legacy timestamps replay from zero with stable receipt ids", async () => {
	const envObject = env();
	await seedLifecycle(envObject, "job-b13-2", "2026-09-15T08:00:00.000Z");
	const headers = { Authorization: `Bearer ${INGEST_TOKEN}` };
	const first = await (
		await worker.fetch(new Request(RECEIPTS_URL, { headers }), envObject, {})
	).json();
	assert.equal(first.receipts.length, 6);
	assert.match(first.next_since, /^rcpt3\./);

	// A current-epoch rcpt3 cursor resumes strictly after its sequence; once at
	// the end, the page is empty and the cursor is echoed unchanged.
	const again = await (
		await worker.fetch(
			new Request(`${RECEIPTS_URL}?since=${encodeURIComponent(first.next_since)}`, {
				headers,
			}),
			envObject,
			{},
		)
	).json();
	assert.deepEqual(again.receipts, []);
	assert.equal(again.next_since, first.next_since);

	// Legacy timestamp cursors deliberately replay the complete new ordering from
	// zero once. Stable receipt ids let the RESEARCH mirror absorb that overlap.
	const replay = await (
		await worker.fetch(
			new Request(
				`${RECEIPTS_URL}?since=${encodeURIComponent(first.receipts[0].occurred_at)}`,
				{ headers },
			),
			envObject,
			{},
		)
	).json();
	assert.equal(replay.receipts.length, 6);
	assert.match(replay.next_since, /^rcpt3\./);
	assert.deepEqual(
		replay.receipts.map((receipt) => receipt.receipt_id),
		first.receipts.map((receipt) => receipt.receipt_id),
	);
});

test("A8 ingest 2 MiB body gate: Content-Length precheck and measured-bytes double gate", async () => {
	const envObject = env();
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_TOKEN}` };
	// Exactly at the ceiling passes the gate (and then fails JSON parsing).
	const atLimit = await worker.fetch(
		new Request(INGEST_URL, { method: "POST", headers, body: "x".repeat(2 * 1024 * 1024) }),
		envObject,
		{},
	);
	assert.equal(atLimit.status, 400);
	assert.equal((await atLimit.json()).error_code, "INTEGRITY_FAILED");
	// One byte over the ceiling is rejected as 413 RATE_LIMITED.
	const overLimit = await worker.fetch(
		new Request(INGEST_URL, {
			method: "POST",
			headers: { ...headers, "Content-Length": String(2 * 1024 * 1024 + 1) },
			body: "x".repeat(2 * 1024 * 1024 + 1),
		}),
		envObject,
		{},
	);
	assert.equal(overLimit.status, 413);
	const overBody = await overLimit.json();
	assert.equal(overBody.error_code, "RATE_LIMITED");
	assert.deepEqual(Object.keys(overBody).sort(), [
		"error_code",
		"request_id",
		"retryable",
		"safe_message",
	]);
});
