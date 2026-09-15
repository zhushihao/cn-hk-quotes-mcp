#!/usr/bin/env node
/**
 * E2E driver for the research work-queue loopback scenario
 * (#5 research-backend design §7.2, zero-dependency: global fetch + MCP
 * streamable HTTP + node:crypto only).
 *
 * Prerequisites (see §7.1, all credentials are synthetic placeholders from
 * .dev.vars and never leave this machine):
 *   1. `npx wrangler d1 migrations apply RESEARCH_REPLICA --local`
 *   2. `npx wrangler dev --local --ip 127.0.0.1 --port 8787` with .dev.vars
 *   3. RESEARCH-side outbound producer drained at least one v3 batch into the
 *      replica (>=2 documents/evidence, 1 accumulator, 1 coverage,
 *      1 source_health, >=2 QUEUED jobs of which 1 PRIVATE).
 *   4. Optional RESEARCH-side receipt puller (step 7 lives in the research
 *      repository; this driver exercises the endpoint contract only).
 *
 * Every step appends one JSONL line to <evidence-dir>/research-workflow-<ts>.jsonl
 * and the run ends with a summary line plus exit code 0/1.  Fail semantics:
 * the script stops at the first failing step and exits non-zero.
 *
 * Usage:
 *   node scripts/e2e-research-workflow.mjs \
 *     [--base-url http://127.0.0.1:8787] \
 *     [--mcp-token local-dev-token] \
 *     [--ingest-token local-ingest-token] \
 *     [--evidence-dir e2e-evidence]
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CLI + evidence plumbing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const options = {
		baseUrl: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8790",
		mcpToken: "local-dev-token",
		ingestToken: "local-ingest-token",
		evidenceDir: "e2e-evidence",
	};
	for (let index = 2; index < argv.length; index += 2) {
		const key = argv[index]?.replace(/^--/, "").replaceAll("-", "_");
		const value = argv[index + 1];
		if (key in options && typeof value === "string") options[key] = value;
		else throw new Error(`unknown or malformed argument pair: ${argv[index]} ${value ?? ""}`);
	}
	return options;
}

const options = parseArgs(process.argv);
mkdirSync(options.evidenceDir, { recursive: true });
const evidenceFile = join(
	options.evidenceDir,
	`research-workflow-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.jsonl`,
);

/** One JSONL line per step; tokens are never logged (synthetic or not). */
function evidence(line) {
	const record = { timestamp: new Date().toISOString(), ...line };
	appendFileSync(evidenceFile, `${JSON.stringify(record)}\n`);
	console.log(JSON.stringify(record));
}

function failFast(step, message, detail = {}) {
	evidence({ step, ok: false, error: message, ...detail });
	console.error(`E2E FAIL at step "${step}": ${message}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal MCP streamable-HTTP client (JSON-RPC over POST /mcp)
// ---------------------------------------------------------------------------

class McpStreamableClient {
	constructor(baseUrl, token) {
		this.endpoint = `${baseUrl}/mcp`;
		this.token = token;
		this.sessionId = null;
		this.nextId = 1;
	}

	async rpc(method, params, { expectResult = true } = {}) {
		const body = { jsonrpc: "2.0", id: this.nextId++, method, params };
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${this.token}`,
				...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
			},
			body: JSON.stringify(body),
		});
		if (response.status === 404 || response.status === 400) {
			// Session may have expired; retry once without the session header.
			this.sessionId = null;
			return this.rpc(method, params, { expectResult });
		}
		const sessionHeader = response.headers.get("Mcp-Session-Id");
		if (sessionHeader) this.sessionId = sessionHeader;
		if (!expectResult) return { status: response.status };
		const contentType = response.headers.get("Content-Type") ?? "";
		const raw = await response.text();
		let payload;
		if (contentType.includes("text/event-stream")) {
			// Take the first data line that parses as JSON-RPC.
			payload = raw
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.find((candidate) => candidate !== null);
		} else {
			payload = JSON.parse(raw);
		}
		if (!payload) throw new Error(`no JSON-RPC payload for ${method}`);
		if (payload.error)
			throw new Error(`JSON-RPC error for ${method}: ${JSON.stringify(payload.error)}`);
		return payload.result;
	}

	async initialize() {
		const result = await this.rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "e2e-research-workflow", version: "0.1.0" },
		});
		await this.rpc("notifications/initialized", {}, { expectResult: false });
		return result;
	}

	async listTools() {
		return (await this.rpc("tools/list", {})).tools ?? [];
	}

	async callTool(name, argsObject) {
		const result = await this.rpc("tools/call", { name, arguments: argsObject ?? {} });
		const text = result?.content?.[0]?.text ?? "";
		let payload = null;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = null;
		}
		return { isError: result?.isError === true, payload, text };
	}
}

// ---------------------------------------------------------------------------
// OAuth side channel (step 8): PKCE S256 + owner_key consent + token exchange
// ---------------------------------------------------------------------------

function pkcePair() {
	const verifier = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

async function oauthToken(baseUrl, ownerKey, scope, clientName) {
	const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
	if (!metadataResponse.ok)
		throw new Error(`authorization server metadata unavailable (${metadataResponse.status})`);
	const metadata = await metadataResponse.json();
	const registrationEndpoint = metadata.registration_endpoint;
	if (!registrationEndpoint) throw new Error("no registration_endpoint advertised");
	const registerResponse = await fetch(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: ["http://127.0.0.1:0/callback"],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code"],
			response_types: ["code"],
			scope,
		}),
	});
	if (!registerResponse.ok)
		throw new Error(`dynamic client registration failed (${registerResponse.status})`);
	const client = await registerResponse.json();
	const { verifier, challenge } = pkcePair();
	const authorizeUrl = new URL(metadata.authorization_endpoint);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("client_id", client.client_id);
	authorizeUrl.searchParams.set("redirect_uri", client.redirect_uris[0]);
	authorizeUrl.searchParams.set("scope", scope);
	authorizeUrl.searchParams.set("state", randomUUID());
	authorizeUrl.searchParams.set("code_challenge", challenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	// §A2 resource：OAuth Provider 要求 resource 指向生产 MCP resource（与
	// oauth-local-lifecycle 测试同值）；缺失或错值会被 parseAuthRequest 拒。
	authorizeUrl.searchParams.set(
		"resource",
		"https://cn-hk-quotes-mcp.zhushihao710.workers.dev/mcp",
	);
	const consentPage = await fetch(authorizeUrl, { redirect: "manual" });
	const consentHtml = await consentPage.text();
	const csrfMatch = consentHtml.match(/name="csrf" value="([^"]+)"/);
	const actionMatch = consentHtml.match(/action="([^"]+)"/);
	// The form action embeds the authorize query with HTML-escaped ampersands
	// (&amp;); decode entities before resolving, otherwise the server sees a
	// malformed query and rejects the consent POST.
	const rawAction = actionMatch[1].replaceAll("&amp;", "&");
	const actionUrl = new URL(rawAction, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	if (!csrfMatch || !actionMatch) throw new Error("consent page did not render a csrf form");
	const approveResponse = await fetch(actionUrl, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			csrf: csrfMatch[1],
			owner_key: ownerKey,
		}),
	});
	const location = approveResponse.headers.get("Location") ?? "";
	const code = new URL(location, baseUrl).searchParams.get("code");
	if (!code) {
		const errBody = await approveResponse.text();
		throw new Error(
			`authorization code missing (status ${approveResponse.status}) action=${actionUrl} ownerKeyLen=${String(ownerKey).length}: ${errBody.slice(0, 300)}`,
		);
	}
	const tokenResponse = await fetch(metadata.token_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: client.client_id,
			redirect_uri: client.redirect_uris[0],
			code_verifier: verifier,
		}),
	});
	if (!tokenResponse.ok) throw new Error(`token exchange failed (${tokenResponse.status})`);
	return (await tokenResponse.json()).access_token;
}

/** Step 8 side channel: a market:read-only OAuth token (scope rejection probe). */
function oauthMarketReadOnlyToken(baseUrl, ownerKey) {
	return oauthToken(baseUrl, ownerKey, "market:read", "e2e-research-scope-probe");
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertOk(step, condition, message, detail = {}) {
	if (!condition) failFast(step, message, detail);
}

function domainPayload(step, tool, call) {
	assertOk(step, call.isError === false, `${tool} returned isError`, {
		tool,
		text: call.text.slice(0, 300),
	});
	assertOk(
		step,
		call.payload && typeof call.payload === "object",
		`${tool} returned non-object payload`,
		{ tool },
	);
	evidence({ step, tool, ok: true, request_id: call.payload?.request_id ?? null });
	return call.payload;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

// §A4 §7.2 main channel: the MCP /mcp route only admits an OAuth access token.
// options.mcpToken is the static client credential used as the owner_key during
// the consent step; the resulting bearer token is what actually reaches /mcp.
const MAIN_CHANNEL_SCOPE = "market:read research:claim research:submit";
const mainClient = new McpStreamableClient(
	options.baseUrl,
	await oauthToken(options.baseUrl, options.mcpToken, MAIN_CHANNEL_SCOPE, "e2e-research-main"),
);
const toolSuccess = new Map();

function markTool(name) {
	toolSuccess.set(name, (toolSuccess.get(name) ?? 0) + 1);
}

async function step1InitializeAndCountTools() {
	const step = "1.initialize";
	const info = await mainClient.initialize();
	evidence({ step, ok: true, server: info?.serverInfo ?? null });
	const tools = await mainClient.listTools();
	const names = tools.map((tool) => tool.name).sort();
	assertOk(step, names.length === 18, `expected exactly 18 tools, got ${names.length}`, {
		names,
	});
	for (const expected of [
		"claim_research_job",
		"defer_research_job",
		"submit_research_result_proposal",
		"get_market_signal_state",
		"get_source_health",
	]) {
		assertOk(step, names.includes(expected), `missing tool ${expected}`, { names });
	}
	// #19 safety-gate compatibility: no model-facing inputSchema may
	// advertise a credential-like claim_token parameter.
	for (const tool of tools) {
		assertOk(
			step,
			!JSON.stringify(tool.inputSchema).includes("claim_token"),
			`${tool.name} inputSchema advertises claim_token`,
		);
	}
	evidence({ step: "1.tools", ok: true, count: names.length, claim_token_free: true });
}

async function step2ReadPlane() {
	const step = "2.read-plane";
	const docs = domainPayload(
		step,
		"search_documents",
		await mainClient.callTool("search_documents", { limit: 10 }),
	);
	const firstDoc = Array.isArray(docs) ? docs[0] : docs?.results?.[0];
	const documentId =
		firstDoc?.payload?.document?.document_id ??
		firstDoc?.document?.document_id ??
		firstDoc?.record_key;
	assertOk(step, typeof documentId === "string", "no synthetic document found in replica", {
		isArray: Array.isArray(docs),
		firstResultKeys: firstDoc ? Object.keys(firstDoc) : null,
		payloadKeys: firstDoc?.payload ? Object.keys(firstDoc.payload) : null,
	});
	markTool("search_documents");
	domainPayload(
		step,
		"get_document",
		await mainClient.callTool("get_document", { document_id: documentId }),
	);
	markTool("get_document");
	const evidenceSearch = domainPayload(
		step,
		"search_evidence",
		await mainClient.callTool("search_evidence", { limit: 10 }),
	);
	const firstEvidence = Array.isArray(evidenceSearch) ? evidenceSearch[0] : evidenceSearch?.results?.[0];
	const evidenceId =
		firstEvidence?.payload?.evidence?.evidence_id ??
		firstEvidence?.evidence?.evidence_id ??
		firstEvidence?.record_key ??
		null;
	assertOk(step, typeof evidenceId === "string", "no synthetic evidence found", {
		evidenceSearch,
	});
	markTool("search_evidence");
	domainPayload(
		step,
		"get_evidence",
		await mainClient.callTool("get_evidence", { evidence_id: evidenceId }),
	);
	markTool("get_evidence");
	const accumulators = domainPayload(
		step,
		"get_theme_accumulator",
		await mainClient.callTool("get_theme_accumulator", { subject_key: "e2e-theme" }),
	);
	const firstAccum = Array.isArray(accumulators) ? accumulators[0] : accumulators;
	const themeKey = firstAccum?.payload?.subject_key ?? firstAccum?.subject_key ?? null;
	assertOk(step, themeKey === "e2e-theme", "no accumulator snapshot found", { accumulators });
	markTool("get_theme_accumulator");
	domainPayload(
		step,
		"get_company_evidence_state",
		await mainClient.callTool("get_company_evidence_state", { company: "e2e-theme" }),
	);
	markTool("get_company_evidence_state");
	domainPayload(
		step,
		"get_coverage_status",
		await mainClient.callTool("get_coverage_status", { limit: 10 }),
	);
	markTool("get_coverage_status");
	const health = domainPayload(
		step,
		"get_source_health",
		await mainClient.callTool("get_source_health", { limit: 10 }),
	);
	const firstHealth = Array.isArray(health) ? health : health?.results;
	assertOk(
		step,
		Array.isArray(firstHealth),
		"source health must be a real row set (not a stub)",
		{ health },
	);
	markTool("get_source_health");
	// §A5 verbatim empty state: the market detector is not deployed this round.
	const signal = domainPayload(
		step,
		"get_market_signal_state",
		await mainClient.callTool("get_market_signal_state", {
			subject_key: "e2e-synthetic-index",
		}),
	);
	assertOk(
		step,
		JSON.stringify(signal) ===
			JSON.stringify({
				status: "NO_DATA",
				subject_key: "market:e2e-synthetic-index",
				source: "COLLECTOR_REPLICA",
				note: "MARKET_DETECTOR_NOT_DEPLOYED",
			}),
		"market signal NO_DATA shape drifted from §A5",
		{ signal },
	);
	markTool("get_market_signal_state");
}

async function step3ClaimContextSubmitLoop() {
	const step = "3.claim-loop";
	const jobs = domainPayload(
		step,
		"list_research_jobs",
		await mainClient.callTool("list_research_jobs", { claimable_only: true }),
	);
	const jobList = Array.isArray(jobs) ? jobs : jobs?.results ?? [];
	// #19: job eligibility is purely server-side state (PUBLIC + QUEUED +
	// lease acquirable); the job_id format never participates in
	// authorization, so any QUEUED PUBLIC job is claimable.
	const queued = jobList.find((job) => job.server_state?.effective_status === "QUEUED");
	assertOk(step, queued, "no PUBLIC QUEUED job available", { jobs });
	markTool("list_research_jobs");
	const jobId = queued.record_key;
	const claim = domainPayload(
		step,
		"claim_research_job",
		await mainClient.callTool("claim_research_job", { job_id: jobId }),
	);
	assertOk(step, claim.status === "CLAIMED", `claim returned ${claim.status}`, { claim });
	// #19 safety-gate compatibility: nothing credential-like may reach the model.
	assertOk(step, !Object.keys(claim).includes("claim_token"), "claim response carried claim_token");
	assertOk(step, !JSON.stringify(claim).includes("clt_"), "claim response leaked a token-like string");
	markTool("claim_research_job");
	const context = domainPayload(
		step,
		"get_research_job_context",
		await mainClient.callTool("get_research_job_context", { job_id: jobId }),
	);
	assertOk(
		step,
		context.server_state?.effective_status === "CLAIMED",
		"context server_state not CLAIMED",
		{ context },
	);
	assertOk(
		step,
		Array.isArray(context.payload?.trigger_evidence_ids),
		"v3 context must carry trigger_evidence_ids",
		{ context },
	);
	markTool("get_research_job_context");
	const idempotencyKey = `e2e-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const submit = domainPayload(
		step,
		"submit_research_result_proposal",
		await mainClient.callTool("submit_research_result_proposal", {
			job_id: jobId,
			expected_generation: claim.lease_generation,
			idempotency_key: idempotencyKey,
			// origin deliberately omitted: the engineering principal is not the
			// production identity, so the server must downgrade to SYNTHETIC.
			proposal: {
				job_id: jobId,
				summary: "e2e synthetic shadow summary",
				findings: [],
				recommendation_hint: "NONE",
				sources_consulted: [],
				completed_at: new Date().toISOString(),
			},
		}),
	);
	assertOk(
		step,
		submit.status === "ACCEPTED_SYNTHETIC",
		`expected ACCEPTED_SYNTHETIC, got ${submit.status}`,
		{ submit },
	);
	assertOk(step, submit.job_status === "QUEUED", "synthetic submit must leave the job QUEUED", {
		submit,
	});
	markTool("submit_research_result_proposal");
	// Shadow traffic releases the lease: the job is claimable again.
	const after = domainPayload(
		step,
		"list_research_jobs",
		await mainClient.callTool("list_research_jobs", { claimable_only: true }),
	);
	assertOk(
		step,
		(Array.isArray(after) ? after : after.results ?? []).some((job) => job.record_key === jobId),
		"job did not return to QUEUED after synthetic submit",
		{ after },
	);
	return { jobId, idempotencyKey };
}

async function step4ConcurrentDoubleClaim() {
	const step = "4.concurrent-claim";
	const jobs = domainPayload(
		step,
		"list_research_jobs",
		await mainClient.callTool("list_research_jobs", { claimable_only: true }),
	);
	const jobList5 = Array.isArray(jobs) ? jobs : jobs.results ?? []; const job = jobList5[0];
	assertOk(step, job, "no claimable job for the concurrency step");
	// Two fresh connections issuing the claim simultaneously: exactly one
	// CLAIMED, one ALREADY_CLAIMED (B1 true-concurrency evidence).
	const [a, b] = await Promise.all([
		new McpStreamableClient(options.baseUrl, options.mcpToken).callTool("claim_research_job", {
			job_id: job.record_key,
		}),
		new McpStreamableClient(options.baseUrl, options.mcpToken).callTool("claim_research_job", {
			job_id: job.record_key,
		}),
	]);
	const statuses = [a.payload?.status, b.payload?.status].sort();
	assertOk(
		step,
		!a.isError && !b.isError && statuses[0] === "ALREADY_CLAIMED" && statuses[1] === "CLAIMED",
		`concurrent claims produced ${JSON.stringify(statuses)}`,
		{ a: a.payload, b: b.payload },
	);
	markTool("claim_research_job");
	evidence({
		step,
		ok: true,
		loser_saw_owner: a.payload?.lease_owner ?? b.payload?.lease_owner ?? null,
	});
}

async function step5Idempotency(jobId, idempotencyKey) {
	const step = "5.idempotency";
	const jobs = domainPayload(
		step,
		"list_research_jobs",
		await mainClient.callTool("list_research_jobs", { claimable_only: true }),
	);
	const jobList6 = Array.isArray(jobs) ? jobs : jobs.results ?? []; const job = jobList6.find((candidate) => candidate.record_key === jobId);
	assertOk(step, job, "job missing for idempotency step");
	const claim = domainPayload(
		step,
		"claim_research_job",
		await mainClient.callTool("claim_research_job", { job_id: jobId }),
	);
	assertOk(step, claim.status === "CLAIMED", `re-claim returned ${claim.status}`);
	const proposalBase = {
		job_id: jobId,
		summary: "e2e idempotency summary",
		findings: [],
		recommendation_hint: "NONE",
		sources_consulted: [],
		completed_at: new Date().toISOString(),
	};
	const submitArgs = {
		job_id: jobId,
		expected_generation: claim.lease_generation,
		idempotency_key: `${idempotencyKey}-idem`,
		origin: "SYNTHETIC",
		proposal: proposalBase,
	};
	const first = domainPayload(
		step,
		"submit_research_result_proposal",
		await mainClient.callTool("submit_research_result_proposal", submitArgs),
	);
	assertOk(step, first.status === "ACCEPTED_SYNTHETIC", `first submit ${first.status}`);
	// Same key + same payload -> replay; same key + different payload -> CONFLICT.
	const replay = await mainClient.callTool("submit_research_result_proposal", submitArgs);
	assertOk(
		step,
		replay.payload?.status === "IDEMPOTENT_REPLAY",
		`replay returned ${replay.payload?.status}`,
	);
	const conflict = await mainClient.callTool("submit_research_result_proposal", {
		...submitArgs,
		proposal: { ...proposalBase, summary: "different payload" },
	});
	assertOk(
		step,
		conflict.payload?.status === "REJECTED" && conflict.payload?.reason === "CONFLICT",
		`conflict returned ${JSON.stringify(conflict.payload)}`,
	);
	evidence({
		step,
		ok: true,
		replay: replay.payload?.proposal_id,
		conflict_reason: conflict.payload?.reason,
	});
}

async function step6PrivateInvisible() {
	const step = "6.private";
	const all = domainPayload(
		step,
		"list_research_jobs",
		await mainClient.callTool("list_research_jobs", { limit: 100 }),
	);
	const allList = Array.isArray(all) ? all : all.results ?? []; const privateVisible = allList.filter((job) => job.visibility === "PRIVATE");
	assertOk(
		step,
		privateVisible.length === 0,
		"PRIVATE job leaked through the PUBLIC read plane",
		{
			count: privateVisible.length,
		},
	);
	const privateJob = await mainClient.callTool("claim_research_job", {
		job_id: "e2e-private-job-probe",
	});
	// Unknown ids and PRIVATE ids share the same NOT_FOUND semantics: no
	// existence oracle either way.
	assertOk(
		step,
		!privateJob.isError &&
			privateJob.payload?.status === "NOT_CLAIMABLE" &&
			privateJob.payload?.reason === "NOT_FOUND",
		"claim on unknown id must be NOT_FOUND (no oracle for PRIVATE either)",
		privateJob.payload,
	);
	evidence({ step, ok: true });
}

async function step7ReceiptsEndpointContract() {
	const step = "7.receipts";
	// The full RESEARCH-side puller lives in the research repository; here we
	// prove the endpoint contract the puller consumes.
	const unauthenticated = await fetch(`${options.baseUrl}/internal/research-replica/v2/receipts`);
	assertOk(
		step,
		unauthenticated.status === 401 || unauthenticated.status === 503,
		`unauthenticated receipts gave ${unauthenticated.status}`,
	);
	const page = await fetch(`${options.baseUrl}/internal/research-replica/v2/receipts`, {
		headers: { Authorization: `Bearer ${options.ingestToken}` },
	});
	assertOk(step, page.status === 200, `receipts page status ${page.status}`);
	const body = await page.json();
	assertOk(
		step,
		body.schema_version === "collector-receipts-v1",
		"receipts schema_version drifted",
		{
			schema_version: body.schema_version,
		},
	);
	assertOk(step, !JSON.stringify(body).includes("clt_"), "claim_token leaked into receipts");
	assertOk(
		step,
		Array.isArray(body.receipts) && body.receipts.length > 0,
		"expected receipt rows for the lifecycle driven by steps 3-5",
	);
	evidence({ step, ok: true, receipts: body.receipts.length, next_since: body.next_since });
}

async function step8OAuthSideChannel() {
	const step = "8.oauth-side-channel";
	const token = await oauthMarketReadOnlyToken(options.baseUrl, options.mcpToken);
	evidence({ step: "8.token", ok: true, scope: "market:read only" });
	// The market:read-only token must be denied the write plane...
	const oauthClient = new McpStreamableClient(options.baseUrl, token);
	await oauthClient.initialize();
	const denied = await oauthClient.callTool("claim_research_job", { job_id: "any-job" });
	assertOk(
		step,
		denied.isError && denied.payload?.error_code === "FILTERED",
		"claim without research:claim must be FILTERED",
		denied.payload,
	);
	// ...while the read plane stays open (read tools carry no research scope).
	const read = await oauthClient.callTool("get_source_health", { limit: 5 });
	assertOk(
		step,
		read.isError === false,
		"read plane must not require a research scope",
		read.payload,
	);
	evidence({ step, ok: true, claim_filtered: true, read_ok: true });
}

async function main() {
	evidence({ step: "0.start", ok: true, base_url: options.baseUrl, evidence_file: evidenceFile });
	await step1InitializeAndCountTools();
	await step2ReadPlane();
	const { jobId, idempotencyKey } = await step3ClaimContextSubmitLoop();
	await step4ConcurrentDoubleClaim();
	await step5Idempotency(jobId, idempotencyKey);
	await step6PrivateInvisible();
	await step7ReceiptsEndpointContract();
	await step8OAuthSideChannel();
	const summary = {
		step: "summary",
		ok: true,
		tools_exercised: [...toolSuccess.entries()].sort(),
		total_tool_calls: [...toolSuccess.values()].reduce((sum, count) => sum + count, 0),
		verdict: "READY_FOR_AUTOMATION_SHADOW_EVIDENCE",
	};
	evidence(summary);
	writeFileSync(
		join(options.evidenceDir, "research-workflow-summary.json"),
		JSON.stringify(summary, null, 2),
	);
}

main().catch((error) => {
	failFast("fatal", error?.message ?? String(error));
});
