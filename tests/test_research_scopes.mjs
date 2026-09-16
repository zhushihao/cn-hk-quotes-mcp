/**
 * Research write-plane scope gate tests (#5 research-backend design §A4,
 * matrix B8/B10).
 *
 * B10 exercises the pure `resolveResearchScopes` rules; B8 drives the real
 * registered tool through an in-memory MCP client to prove the FILTERED
 * envelope and that no lease row is written; a wiring assertion pins the
 * OAuth bridge's strip-before-set discipline for the forwarded scope header.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

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

import { createResearchWorkflowDb } from "./helpers/d1-sqlite-shim.mjs";

const { resolveResearchScopes, RESEARCH_CLAIM_SCOPE, RESEARCH_SUBMIT_SCOPE } =
	await import("../src/research-scopes.ts");
const { createServer } = await import("../src/index.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const CONFIGURED_TOKEN = "synthetic-collector-token";
const CONFIGURED_SCOPES = "market:read research:claim research:submit";

function scopesOf(set) {
	return [...set].sort();
}

test("B10 anonymous or wrong-credential callers get the empty scope set", () => {
	assert.equal(
		scopesOf(resolveResearchScopes(null, null, CONFIGURED_TOKEN, CONFIGURED_SCOPES)).length,
		0,
	);
	assert.equal(
		scopesOf(resolveResearchScopes(undefined, undefined, CONFIGURED_TOKEN, CONFIGURED_SCOPES))
			.length,
		0,
	);
	// Unconfigured server token: fail-closed even if a header matches nothing.
	assert.equal(
		scopesOf(resolveResearchScopes("Bearer x", null, undefined, CONFIGURED_SCOPES)).length,
		0,
	);
	assert.equal(
		scopesOf(resolveResearchScopes("Bearer wrong", null, CONFIGURED_TOKEN, CONFIGURED_SCOPES))
			.length,
		0,
	);
	// Byte-exact match is required (prefix/suffix games fail).
	assert.equal(
		scopesOf(
			resolveResearchScopes(
				`Bearer ${CONFIGURED_TOKEN} `,
				null,
				CONFIGURED_TOKEN,
				CONFIGURED_SCOPES,
			),
		).length,
		0,
	);
});

test("B10 static-credential path grants exactly the configured set", () => {
	assert.deepEqual(
		scopesOf(
			resolveResearchScopes(
				`Bearer ${CONFIGURED_TOKEN}`,
				null,
				CONFIGURED_TOKEN,
				CONFIGURED_SCOPES,
			),
		),
		["market:read", "research:claim", "research:submit"],
	);
	// The forwarded-header-less grant equals the whole configuration.
	const granted = resolveResearchScopes(
		`Bearer ${CONFIGURED_TOKEN}`,
		null,
		CONFIGURED_TOKEN,
		CONFIGURED_SCOPES,
	);
	assert.equal(granted.has(RESEARCH_CLAIM_SCOPE), true);
	assert.equal(granted.has(RESEARCH_SUBMIT_SCOPE), true);
});

test("B10 forwarded scopes are clamped to the configured ceiling", () => {
	// Forged header asking for everything beyond the ceiling: clamped.
	assert.deepEqual(
		scopesOf(
			resolveResearchScopes(
				`Bearer ${CONFIGURED_TOKEN}`,
				"market:read research:claim research:submit offline_access admin:all",
				CONFIGURED_TOKEN,
				CONFIGURED_SCOPES,
			),
		),
		["market:read", "research:claim", "research:submit"],
	);
	// Header granting less than configured: the intersection wins (least privilege).
	assert.deepEqual(
		scopesOf(
			resolveResearchScopes(
				`Bearer ${CONFIGURED_TOKEN}`,
				"market:read",
				CONFIGURED_TOKEN,
				CONFIGURED_SCOPES,
			),
		),
		["market:read"],
	);
	// Empty forwarded header (OAuth token without research scopes): nothing.
	assert.deepEqual(
		scopesOf(
			resolveResearchScopes(
				`Bearer ${CONFIGURED_TOKEN}`,
				"",
				CONFIGURED_TOKEN,
				CONFIGURED_SCOPES,
			),
		),
		[],
	);
});

test("B10 no scope implies any other scope (escalation ban)", () => {
	const pairs = [
		[new Set(["market:read"]), RESEARCH_CLAIM_SCOPE],
		[new Set(["market:read"]), RESEARCH_SUBMIT_SCOPE],
		[new Set([RESEARCH_CLAIM_SCOPE]), RESEARCH_SUBMIT_SCOPE],
		[new Set([RESEARCH_SUBMIT_SCOPE]), RESEARCH_CLAIM_SCOPE],
	];
	for (const [granted, required] of pairs) {
		assert.equal(granted.has(required), false, `${[...granted]} must not imply ${required}`);
	}
});

async function connectedClient(
	env,
	grantedScopes,
	researchPrincipal = null,
	researchIssuer = null,
) {
	const server = createServer(env, "ENABLED", grantedScopes, researchPrincipal, researchIssuer);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "scope-gate-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

function syntheticEnv() {
	return {
		COLLECTOR_MCP_CLIENT_TOKEN: CONFIGURED_TOKEN,
		COLLECTOR_MCP_CLIENT_ID: "chatgpt-production",
		COLLECTOR_MCP_CLIENT_SCOPES: CONFIGURED_SCOPES,
		RESEARCH_REPLICA: createResearchWorkflowDb(),
		RESEARCH_OBJECTS: { async put() {} },
	};
}

test("B8 claim without research:claim is FILTERED and writes no lease row", async () => {
	const env = syntheticEnv();
	const { client, server } = await connectedClient(env, new Set(["market:read"]));
	try {
		const result = await client.callTool({
			name: "claim_research_job",
			arguments: { job_id: "job-b8" },
		});
		assert.equal(result.isError, true);
		const envelope = JSON.parse(result.content[0].text);
		assert.equal(envelope.error_code, "FILTERED");
		assert.equal(typeof envelope.request_id, "string");
		assert.equal(typeof envelope.safe_message, "string");
		assert.equal(typeof envelope.retryable, "boolean");
		const leases = await env.RESEARCH_REPLICA.prepare(
			"SELECT job_id FROM research_job_leases",
		).all();
		assert.equal(leases.results.length, 0);
	} finally {
		await server.close();
	}
});

test("B8 submit without research:submit is FILTERED even with research:claim", async () => {
	const env = syntheticEnv();
	const { client, server } = await connectedClient(env, new Set([RESEARCH_CLAIM_SCOPE]));
	try {
		const result = await client.callTool({
			name: "submit_research_result_proposal",
			arguments: {
				job_id: "job-b8",
				expected_generation: 1,
				idempotency_key: "key-b8-submit",
				proposal: {},
			},
		});
		assert.equal(result.isError, true);
		assert.equal(JSON.parse(result.content[0].text).error_code, "FILTERED");
		const proposals = await env.RESEARCH_REPLICA.prepare(
			"SELECT proposal_id FROM research_proposals",
		).all();
		assert.equal(proposals.results.length, 0);
	} finally {
		await server.close();
	}
});

test("B8 control: with research:claim granted the claim reaches the workflow", async () => {
	const env = syntheticEnv();
	const { client, server } = await connectedClient(
		env,
		new Set(["market:read", RESEARCH_CLAIM_SCOPE]),
		"stable-research-principal",
		"https://issuer.example",
	);
	try {
		const result = await client.callTool({
			name: "claim_research_job",
			arguments: { job_id: "job-b8-unknown" },
		});
		// No scope denial: the domain result for an unknown job comes back.
		assert.equal(result.isError, undefined);
		const payload = JSON.parse(result.content[0].text);
		assert.equal(payload.status, "NOT_CLAIMABLE");
		assert.equal(payload.reason, "NOT_FOUND");
	} finally {
		await server.close();
	}
});

test("OAuth bridge strips any client-supplied forwarded-scope header before setting its own", async () => {
	const oauth = await readFile(new URL("../src/oauth-entry.ts", import.meta.url), "utf8");
	const deleteAt = oauth.indexOf("headers.delete(FORWARDED_SCOPES_HEADER)");
	const setAt = oauth.indexOf(`headers.set(FORWARDED_SCOPES_HEADER, summary.scope.join(" "))`);
	assert.ok(deleteAt > 0, "client-supplied header must be deleted");
	assert.ok(setAt > deleteAt, "the bridge's own header is set only after the strip");
});
