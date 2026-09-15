import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = await import("../src/research-workflow.ts");

/**
 * Isolated SQLite execution of the Collector's actual D1 workflow SQL.  The
 * identities and records below are synthetic test-namespace values only; no
 * credential, deployed Worker, or ChatGPT Automation is involved.
 */
class SqliteD1 {
	constructor({ triggerInflatedChanges = false } = {}) {
		this.sqlite = new DatabaseSync(":memory:");
		this.triggerInflatedChanges = triggerInflatedChanges;
		for (const migration of [
			"0001_research_replica.sql",
			"0003_research_workflow.sql",
			"0004_research_replica_v4.sql",
			"0005_research_workflow_deferrals.sql",
			"0006_research_workflow_ingress_sequence.sql",
		]) {
			this.sqlite.exec(readFileSync(path.join("migrations", migration), "utf8"));
		}
	}

	prepare(sql) {
		const db = this;
		const sqlite = this.sqlite;
		let values = [];
		return {
			bind(...params) {
				values = params;
				return this;
			},
			async run() {
				const result = sqlite.prepare(sql).run(...values);
				const triggerChanges = db.triggerInflatedChanges && sql.includes("research_job_events") ? 1 : 0;
				return { meta: { changes: Number(result.changes) + triggerChanges } };
			},
			async first() {
				return sqlite.prepare(sql).get(...values) ?? null;
			},
			async all() {
				return { results: sqlite.prepare(sql).all(...values) };
			},
		};
	}

	async batch(statements) {
		const results = [];
		for (const statement of statements) results.push(await statement.run());
		return results;
	}

	seedJob(jobId) {
		this.sqlite
			.prepare(
				"INSERT INTO research_records (record_type, record_key, message_id, visibility, schema_version, payload_json, generated_at, updated_at) VALUES ('job', ?, ?, 'PUBLIC', 'collector-outbound-v4', '{}', ?, ?)",
			)
			.run(jobId, `outbound_${jobId}`, NOW, NOW);
	}

	count(sql, ...values) {
		return Number(this.sqlite.prepare(sql).get(...values).count);
	}
}

const NOW = "2026-09-15T00:00:00.000Z";
const EXPIRED = "2026-09-15T01:00:00.000Z";
const FORMAL_OWNER_A = `oauth-client:${"a".repeat(64)}`;
const FORMAL_OWNER_B = `oauth-client:${"b".repeat(64)}`;

function proposal(jobId, summary = "synthetic shadow result") {
	return {
		job_id: jobId,
		summary,
		findings: [],
		recommendation_hint: "NONE",
		sources_consulted: [],
		completed_at: NOW,
	};
}

test("G07 concurrent and duplicate claims keep one current owner and a stable same-owner lease", async () => {
	const db = new SqliteD1();
	db.seedJob("job-concurrent");
	const outcomes = await Promise.all([
		workflow.claimResearchJob(db, { jobId: "job-concurrent", leaseOwner: "synthetic-owner-a", requestId: "req-claim-a", now: NOW }),
		workflow.claimResearchJob(db, { jobId: "job-concurrent", leaseOwner: "synthetic-owner-b", requestId: "req-claim-b", now: NOW }),
	]);
	const claimed = outcomes.filter((outcome) => outcome.status === "CLAIMED");
	const blocked = outcomes.filter((outcome) => outcome.status === "ALREADY_CLAIMED");
	assert.equal(claimed.length, 1);
	assert.equal(blocked.length, 1);
	const replay = await workflow.claimResearchJob(db, {
		jobId: "job-concurrent",
		leaseOwner: claimed[0].lease_owner,
		requestId: "req-claim-retry",
		now: NOW,
	});
	assert.equal(replay.status, "CLAIMED");
	assert.equal(replay.claim_token, claimed[0].claim_token);
	assert.equal(replay.claim_count, 1);
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_leases WHERE job_id=?", "job-concurrent"), 1);
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_events WHERE job_id=? AND event_type='CLAIMED'", "job-concurrent"), 1);
});

test("G08 expiry, Automation interruption, and fencing reject the superseded owner", async () => {
	const db = new SqliteD1();
	db.seedJob("job-expiry");
	const oldLease = await workflow.claimResearchJob(db, {
		jobId: "job-expiry", leaseOwner: "synthetic-interrupted", requestId: "req-old", now: NOW,
	});
	assert.equal(oldLease.status, "CLAIMED");
	// No submit simulates an interrupted Automation.  The next claimant takes
	// over only at server-side expiry, and the former token is fenced off.
	const renewed = await workflow.claimResearchJob(db, {
		jobId: "job-expiry", leaseOwner: "synthetic-recovery", requestId: "req-new", now: EXPIRED,
	});
	assert.equal(renewed.status, "CLAIMED");
	assert.equal(renewed.claim_count, 2);
	const stale = await workflow.submitResearchResultProposal(db, {
		jobId: "job-expiry", claimToken: oldLease.claim_token, expectedGeneration: oldLease.lease_generation, idempotencyKey: "retry-old-result", origin: "SYNTHETIC",
		proposal: proposal("job-expiry"), callerPrincipal: "synthetic-interrupted", requestId: "req-stale", now: EXPIRED,
	});
	assert.deepEqual(stale.status, "REJECTED");
	assert.deepEqual(stale.reason, "LEASE_INVALID");
	assert.equal(stale.detail.sub_reason, "TOKEN_MISMATCH");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_events WHERE job_id=? AND event_type='LEASE_EXPIRED'", "job-expiry"), 1);
});

test("G09 repeated submit/network retry has exactly one formal accepted owner and result", async () => {
	const db = new SqliteD1();
	db.seedJob("job-formal");
	const lease = await workflow.claimResearchJob(db, {
		jobId: "job-formal", leaseOwner: FORMAL_OWNER_A, requestId: "req-formal-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const input = {
		jobId: "job-formal", claimToken: lease.claim_token, expectedGeneration: lease.lease_generation, idempotencyKey: "formal-submit-key", origin: "CHATGPT",
		proposal: proposal("job-formal"), callerPrincipal: FORMAL_OWNER_A, requestId: "req-formal-submit", now: NOW,
	};
	const accepted = await workflow.submitResearchResultProposal(db, input);
	assert.equal(accepted.status, "ACCEPTED");
	const networkRetry = await workflow.submitResearchResultProposal(db, { ...input, requestId: "req-formal-retry" });
	assert.equal(networkRetry.status, "IDEMPOTENT_REPLAY");
	assert.equal(networkRetry.proposal_id, accepted.proposal_id);
	const conflictingRetry = await workflow.submitResearchResultProposal(db, {
		...input,
		proposal: proposal("job-formal", "different body must not reuse the idempotency key"),
		requestId: "req-formal-conflict",
	});
	assert.equal(conflictingRetry.status, "REJECTED");
	assert.equal(conflictingRetry.reason, "CONFLICT");
	const duplicateComplete = await workflow.submitResearchResultProposal(db, {
		...input, idempotencyKey: "second-complete-key", requestId: "req-second-complete",
	});
	assert.equal(duplicateComplete.status, "REJECTED");
	assert.equal(duplicateComplete.reason, "LEASE_INVALID");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_terminal WHERE job_id=?", "job-formal"), 1);
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_proposals WHERE job_id=? AND origin='CHATGPT' AND status='RECEIVED'", "job-formal"), 1);
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_events WHERE job_id=? AND event_type='COMPLETED'", "job-formal"), 1);
});

test("G09 test principals are downgraded: a synthetic shadow proposal cannot complete a formal job", async () => {
	const db = new SqliteD1();
	db.seedJob("job-shadow");
	const lease = await workflow.claimResearchJob(db, {
		jobId: "job-shadow", leaseOwner: "synthetic-shadow", requestId: "req-shadow-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const result = await workflow.submitResearchResultProposal(db, {
		jobId: "job-shadow", claimToken: lease.claim_token, expectedGeneration: lease.lease_generation, idempotencyKey: "shadow-submit-key", origin: "CHATGPT",
		proposal: proposal("job-shadow"), callerPrincipal: "synthetic-shadow", requestId: "req-shadow-submit", now: NOW,
	});
	assert.equal(result.status, "ACCEPTED_SYNTHETIC");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_terminal WHERE job_id=?", "job-shadow"), 0);
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_proposals WHERE job_id=? AND origin='CHATGPT'", "job-shadow"), 0);
});

test("G07 authenticated formal owners are client-specific and a second client cannot replay another lease", async () => {
	const db = new SqliteD1();
	db.seedJob("job-owner-isolation");
	const first = await workflow.claimResearchJob(db, {
		jobId: "job-owner-isolation", leaseOwner: FORMAL_OWNER_A, requestId: "req-owner-a", now: NOW,
	});
	assert.equal(first.status, "CLAIMED");
	const second = await workflow.claimResearchJob(db, {
		jobId: "job-owner-isolation", leaseOwner: FORMAL_OWNER_B, requestId: "req-owner-b", now: NOW,
	});
	assert.equal(second.status, "ALREADY_CLAIMED");
	const stolen = await workflow.submitResearchResultProposal(db, {
		jobId: "job-owner-isolation", claimToken: first.claim_token, expectedGeneration: first.lease_generation,
		idempotencyKey: "owner-isolation-submit", origin: "CHATGPT", proposal: proposal("job-owner-isolation"),
		callerPrincipal: FORMAL_OWNER_B, requestId: "req-owner-stolen", now: NOW,
	});
	assert.equal(stolen.status, "REJECTED");
	assert.equal(stolen.detail.sub_reason, "OWNER_MISMATCH");
	const takeover = await workflow.claimResearchJob(db, {
		jobId: "job-owner-isolation", leaseOwner: FORMAL_OWNER_B, requestId: "req-owner-expiry", now: EXPIRED,
	});
	assert.equal(takeover.status, "CLAIMED");
	assert.equal(takeover.lease_owner, FORMAL_OWNER_B);
	assert.equal(takeover.lease_generation, 2);
});

test("G09 opaque receipt cursor reaches all 501 same-timestamp events without replay looping", async () => {
	const db = new SqliteD1();
	for (let index = 0; index < 501; index += 1) {
		db.sqlite.prepare(
			"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) VALUES (?, 'job-cursor', 'CLAIMED', 'synthetic', NULL, NULL, '{}', ?, ?)",
		).run(`evt-${String(index).padStart(4, "0")}`, `req-${index}`, NOW);
	}
	const first = await workflow.listResearchJobReceipts(db, { limit: 500, now: NOW });
	assert.equal(first.receipts.length, 500);
	assert.match(first.next_since, /^rcpt2\./);
	const second = await workflow.listResearchJobReceipts(db, { since: first.next_since, limit: 500, now: NOW });
	assert.equal(second.receipts.length, 1);
	assert.notEqual(second.receipts[0].receipt_id, first.receipts[0].receipt_id);
	const empty = await workflow.listResearchJobReceipts(db, { since: second.next_since, limit: 500, now: NOW });
	assert.deepEqual(empty.receipts, []);
	assert.equal(empty.next_since, second.next_since);
	const legacy = await workflow.listResearchJobReceipts(db, { since: NOW, limit: 500, now: NOW });
	assert.equal(legacy.receipts.length, 500);
	assert.match(legacy.next_since, /^rcpt2\./);
	await assert.rejects(
		() => workflow.listResearchJobReceipts(db, { since: "rcpt2.not-base64", limit: 1, now: NOW }),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

test("G09 rcpt2 ingress sequence reaches an event written between pages even when its timestamp and id sort backward", async () => {
	const db = new SqliteD1();
	for (const eventId of ["evt-b", "evt-c"]) {
		db.sqlite.prepare(
			"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) VALUES (?, 'job-dynamic-cursor', 'CLAIMED', 'synthetic', NULL, NULL, '{}', ?, ?)",
		).run(eventId, `req-${eventId}`, NOW);
	}
	const first = await workflow.listResearchJobReceipts(db, { limit: 2, now: NOW });
	assert.deepEqual(first.receipts.map((receipt) => receipt.request_id), ["req-evt-b", "req-evt-c"]);
	db.sqlite.prepare(
		"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) VALUES ('evt-a', 'job-dynamic-cursor', 'CLAIMED', 'synthetic', NULL, NULL, '{}', 'req-evt-a', ?)",
	).run(NOW);
	const second = await workflow.listResearchJobReceipts(db, { since: first.next_since, limit: 2, now: NOW });
	assert.deepEqual(second.receipts.map((receipt) => receipt.request_id), ["req-evt-a"]);
});

test("G09 rcpt2 keeps a 64-bit decimal sequence lossless and legacy cursors replay from zero", async () => {
	const db = new SqliteD1();
	db.sqlite.prepare(
		"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at) VALUES ('evt-early', 'job-legacy', 'CLAIMED', 'synthetic', NULL, NULL, '{}', 'req-early', '2020-01-01T00:00:00.000Z')",
	).run();
	db.sqlite.prepare(
		"INSERT INTO research_job_events (event_id, job_id, event_type, actor, proposal_id, origin, detail_json, request_id, created_at, ingress_sequence) VALUES ('evt-u64', 'job-legacy', 'CLAIMED', 'synthetic', NULL, NULL, '{}', 'req-u64', ?, '9007199254740993')",
	).run(NOW);
	const timestampUpgrade = await workflow.listResearchJobReceipts(db, { since: NOW, limit: 10, now: NOW });
	assert.deepEqual(timestampUpgrade.receipts.map((receipt) => receipt.request_id), ["req-early", "req-u64"]);
	const v1 = `rcpt1.${btoa(JSON.stringify({ v: 1, t: NOW, e: "evt-u64" }))}`;
	const v1Upgrade = await workflow.listResearchJobReceipts(db, { since: v1, limit: 10, now: NOW });
	assert.deepEqual(v1Upgrade.receipts.map((receipt) => receipt.request_id), ["req-early", "req-u64"]);
	const cursor = JSON.parse(atob(timestampUpgrade.next_since.slice("rcpt2.".length)));
	assert.equal(typeof cursor.s, "string");
	assert.equal(cursor.s, "9007199254740993");
	const empty = await workflow.listResearchJobReceipts(db, { since: timestampUpgrade.next_since, limit: 10, now: NOW });
	assert.deepEqual(empty.receipts, []);
});

test("G07/G08 trigger-sensitive D1 change counts do not turn committed claim or submit into errors", async () => {
	const db = new SqliteD1({ triggerInflatedChanges: true });
	db.seedJob("job-trigger-count");
	const lease = await workflow.claimResearchJob(db, {
		jobId: "job-trigger-count", leaseOwner: FORMAL_OWNER_A, requestId: "req-trigger-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const submitted = await workflow.submitResearchResultProposal(db, {
		jobId: "job-trigger-count", claimToken: lease.claim_token, expectedGeneration: lease.lease_generation,
		idempotencyKey: "trigger-count-submit", origin: "CHATGPT", proposal: proposal("job-trigger-count"),
		callerPrincipal: FORMAL_OWNER_A, requestId: "req-trigger-submit", now: NOW,
	});
	assert.equal(submitted.status, "ACCEPTED");
});

test("G08 defer is a fenced remote release, retries idempotently, and recheck gates claims", async () => {
	const db = new SqliteD1();
	db.seedJob("job-defer");
	const lease = await workflow.claimResearchJob(db, {
		jobId: "job-defer", leaseOwner: "synthetic-defer", requestId: "req-defer-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const input = {
		jobId: "job-defer", claimToken: lease.claim_token, expectedGeneration: lease.lease_generation, idempotencyKey: "defer-key-0001",
		reason: "RECHECK_REQUIRED", recheckAt: "2026-09-15T00:30:00.000Z",
		callerPrincipal: "synthetic-defer", requestId: "req-defer", now: NOW,
	};
	const deferred = await workflow.deferResearchJob(db, input);
	assert.equal(deferred.status, "DEFERRED");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_leases WHERE job_id=?", "job-defer"), 0);
	const duplicate = await workflow.deferResearchJob(db, { ...input, requestId: "req-defer-retry" });
	assert.equal(duplicate.status, "IDEMPOTENT_REPLAY");
	assert.equal(duplicate.current_status, "DEFERRED");
	const changed = await workflow.deferResearchJob(db, {
		...input, reason: "UPSTREAM_UNAVAILABLE", requestId: "req-defer-changed",
	});
	assert.equal(changed.status, "REJECTED");
	assert.equal(changed.reason, "CONFLICT");
	const changedGeneration = await workflow.deferResearchJob(db, {
		...input, expectedGeneration: input.expectedGeneration + 1, requestId: "req-defer-generation-changed",
	});
	assert.equal(changedGeneration.status, "REJECTED");
	assert.equal(changedGeneration.reason, "CONFLICT");
	const early = await workflow.claimResearchJob(db, {
		jobId: "job-defer", leaseOwner: "synthetic-next", requestId: "req-early", now: "2026-09-15T00:10:00.000Z",
	});
	assert.equal(early.status, "NOT_CLAIMABLE");
	assert.equal(early.reason, "DEFERRED");
	const afterRecheck = await workflow.claimResearchJob(db, {
		jobId: "job-defer", leaseOwner: "synthetic-next", requestId: "req-recheck", now: "2026-09-15T00:31:00.000Z",
	});
	assert.equal(afterRecheck.status, "CLAIMED");
	const historicalReplay = await workflow.deferResearchJob(db, {
		...input, requestId: "req-defer-history", now: "2026-09-15T00:31:00.000Z",
	});
	assert.equal(historicalReplay.status, "IDEMPOTENT_REPLAY");
	assert.equal(historicalReplay.current_status, "CLAIMED");
});

test("G09 terminal-versus-claim leaves no effective lease", async () => {
	const db = new SqliteD1();
	db.seedJob("job-terminal-race");
	db.sqlite.prepare(
		"INSERT INTO research_job_terminal (job_id, terminal_status, proposal_id, completed_at) VALUES ('job-terminal-race', 'COMPLETED', 'prp-existing', ?)",
	).run(NOW);
	const outcome = await workflow.claimResearchJob(db, {
		jobId: "job-terminal-race", leaseOwner: "synthetic-racer", requestId: "req-race", now: NOW,
	});
	assert.equal(outcome.status, "NOT_CLAIMABLE");
	assert.equal(outcome.reason, "TERMINAL");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_leases WHERE job_id=?", "job-terminal-race"), 0);
});

test("G09 submit-versus-defer has one winner and never leaves terminal plus lease", async () => {
	const db = new SqliteD1();
	db.seedJob("job-submit-defer");
	const lease = await workflow.claimResearchJob(db, {
		jobId: "job-submit-defer", leaseOwner: FORMAL_OWNER_A, requestId: "req-race-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const [submitted, deferred] = await Promise.all([
		workflow.submitResearchResultProposal(db, {
			jobId: "job-submit-defer", claimToken: lease.claim_token, expectedGeneration: lease.lease_generation, idempotencyKey: "submit-defer-submit",
			origin: "CHATGPT", proposal: proposal("job-submit-defer"), callerPrincipal: FORMAL_OWNER_A,
			requestId: "req-race-submit", now: NOW,
		}),
		workflow.deferResearchJob(db, {
			jobId: "job-submit-defer", claimToken: lease.claim_token, expectedGeneration: lease.lease_generation, idempotencyKey: "submit-defer-defer",
			reason: "RECHECK_REQUIRED", recheckAt: "2026-09-15T00:30:00.000Z",
			callerPrincipal: FORMAL_OWNER_A, requestId: "req-race-defer", now: NOW,
		}),
	]);
	assert.equal(
		(submitted.status === "ACCEPTED" ? 1 : 0) + (deferred.status === "DEFERRED" ? 1 : 0),
		1,
	);
	assert.equal(
		db.count("SELECT COUNT(*) AS count FROM research_job_terminal WHERE job_id=?", "job-submit-defer") *
			db.count("SELECT COUNT(*) AS count FROM research_job_leases WHERE job_id=?", "job-submit-defer"),
		0,
	);
});
