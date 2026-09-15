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
	constructor() {
		this.sqlite = new DatabaseSync(":memory:");
		for (const migration of [
			"0001_research_replica.sql",
			"0003_research_workflow.sql",
			"0004_research_replica_v4.sql",
			"0005_research_workflow_deferrals.sql",
		]) {
			this.sqlite.exec(readFileSync(path.join("migrations", migration), "utf8"));
		}
	}

	prepare(sql) {
		const sqlite = this.sqlite;
		let values = [];
		return {
			bind(...params) {
				values = params;
				return this;
			},
			async run() {
				const result = sqlite.prepare(sql).run(...values);
				return { meta: { changes: Number(result.changes) } };
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
		jobId: "job-expiry", claimToken: oldLease.claim_token, idempotencyKey: "retry-old-result", origin: "SYNTHETIC",
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
		jobId: "job-formal", leaseOwner: workflow.RESEARCH_PRODUCTION_PRINCIPAL, requestId: "req-formal-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const input = {
		jobId: "job-formal", claimToken: lease.claim_token, idempotencyKey: "formal-submit-key", origin: "CHATGPT",
		proposal: proposal("job-formal"), callerPrincipal: workflow.RESEARCH_PRODUCTION_PRINCIPAL, requestId: "req-formal-submit", now: NOW,
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
		jobId: "job-shadow", claimToken: lease.claim_token, idempotencyKey: "shadow-submit-key", origin: "CHATGPT",
		proposal: proposal("job-shadow"), callerPrincipal: "synthetic-shadow", requestId: "req-shadow-submit", now: NOW,
	});
	assert.equal(result.status, "ACCEPTED_SYNTHETIC");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_terminal WHERE job_id=?", "job-shadow"), 0);
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_proposals WHERE job_id=? AND origin='CHATGPT'", "job-shadow"), 0);
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
	assert.match(first.next_since, /^rcpt1\./);
	const second = await workflow.listResearchJobReceipts(db, { since: first.next_since, limit: 500, now: NOW });
	assert.equal(second.receipts.length, 1);
	assert.notEqual(second.receipts[0].receipt_id, first.receipts[0].receipt_id);
	const empty = await workflow.listResearchJobReceipts(db, { since: second.next_since, limit: 500, now: NOW });
	assert.deepEqual(empty.receipts, []);
	assert.equal(empty.next_since, second.next_since);
	const legacy = await workflow.listResearchJobReceipts(db, { since: NOW, limit: 500, now: NOW });
	assert.equal(legacy.receipts.length, 500);
	assert.match(legacy.next_since, /^rcpt1\./);
	await assert.rejects(
		() => workflow.listResearchJobReceipts(db, { since: "rcpt1.not-base64", limit: 1, now: NOW }),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

test("G08 defer is a fenced remote release, retries idempotently, and recheck gates claims", async () => {
	const db = new SqliteD1();
	db.seedJob("job-defer");
	const lease = await workflow.claimResearchJob(db, {
		jobId: "job-defer", leaseOwner: "synthetic-defer", requestId: "req-defer-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const input = {
		jobId: "job-defer", claimToken: lease.claim_token, idempotencyKey: "defer-key-0001",
		reason: "RECHECK_REQUIRED", recheckAt: "2026-09-15T00:30:00.000Z",
		callerPrincipal: "synthetic-defer", requestId: "req-defer", now: NOW,
	};
	const deferred = await workflow.deferResearchJob(db, input);
	assert.equal(deferred.status, "DEFERRED");
	assert.equal(db.count("SELECT COUNT(*) AS count FROM research_job_leases WHERE job_id=?", "job-defer"), 0);
	const duplicate = await workflow.deferResearchJob(db, { ...input, requestId: "req-defer-retry" });
	assert.equal(duplicate.status, "IDEMPOTENT_REPLAY");
	const early = await workflow.claimResearchJob(db, {
		jobId: "job-defer", leaseOwner: "synthetic-next", requestId: "req-early", now: "2026-09-15T00:10:00.000Z",
	});
	assert.equal(early.status, "NOT_CLAIMABLE");
	assert.equal(early.reason, "DEFERRED");
	const afterRecheck = await workflow.claimResearchJob(db, {
		jobId: "job-defer", leaseOwner: "synthetic-next", requestId: "req-recheck", now: "2026-09-15T00:31:00.000Z",
	});
	assert.equal(afterRecheck.status, "CLAIMED");
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
		jobId: "job-submit-defer", leaseOwner: workflow.RESEARCH_PRODUCTION_PRINCIPAL, requestId: "req-race-claim", now: NOW,
	});
	assert.equal(lease.status, "CLAIMED");
	const [submitted, deferred] = await Promise.all([
		workflow.submitResearchResultProposal(db, {
			jobId: "job-submit-defer", claimToken: lease.claim_token, idempotencyKey: "submit-defer-submit",
			origin: "CHATGPT", proposal: proposal("job-submit-defer"), callerPrincipal: workflow.RESEARCH_PRODUCTION_PRINCIPAL,
			requestId: "req-race-submit", now: NOW,
		}),
		workflow.deferResearchJob(db, {
			jobId: "job-submit-defer", claimToken: lease.claim_token, idempotencyKey: "submit-defer-defer",
			reason: "RECHECK_REQUIRED", recheckAt: "2026-09-15T00:30:00.000Z",
			callerPrincipal: workflow.RESEARCH_PRODUCTION_PRINCIPAL, requestId: "req-race-defer", now: NOW,
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
