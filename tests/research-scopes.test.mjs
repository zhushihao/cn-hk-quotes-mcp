import assert from "node:assert/strict";
import test from "node:test";

const {
	permitsFormalResearchOperation,
	resolveResearchClientId,
	resolveResearchIssuer,
	formalResearchOwner,
} = await import("../src/research-scopes.ts");

test("formal MCP entry requires authenticated allowed client, scope, and namespace", () => {
	const base = {
		issuer: "https://collector.example.test",
		scopes: new Set(["research:claim", "research:submit"]),
		requiredScope: "research:claim",
		configuredClientIds: "chatgpt-production,codex,engineering,producer,receipt-reader",
		configuredNamespaces: "research-formal",
		jobId: "research-formal:job-1",
	};
	assert.equal(permitsFormalResearchOperation({ ...base, clientId: "chatgpt-production" }), true);
	for (const clientId of ["codex", "engineering", "producer", "receipt-reader"]) {
		assert.equal(permitsFormalResearchOperation({ ...base, clientId }), false, clientId);
	}
	assert.equal(permitsFormalResearchOperation({ ...base, clientId: null }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, issuer: null, clientId: "chatgpt-production" }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, clientId: "chatgpt-production", jobId: "synthetic:job-1" }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, clientId: "chatgpt-production", scopes: new Set() }), false);
});

test("OAuth bridge identity is credential-bound and produces separate opaque owners per issuer/client", async () => {
	const bridgeToken = "synthetic-bridge-token";
	assert.equal(resolveResearchClientId(`Bearer ${bridgeToken}`, "chatgpt-a", bridgeToken), "chatgpt-a");
	assert.equal(resolveResearchClientId("Bearer wrong", "chatgpt-a", bridgeToken), null);
	assert.equal(resolveResearchIssuer(`Bearer ${bridgeToken}`, "https://collector.example.test", bridgeToken), "https://collector.example.test");
	assert.equal(resolveResearchIssuer(`Bearer ${bridgeToken}`, "https://collector.example.test/not-an-issuer", bridgeToken), null);
	const first = await formalResearchOwner("https://collector.example.test", "chatgpt-a");
	const same = await formalResearchOwner("https://collector.example.test", "chatgpt-a");
	const secondClient = await formalResearchOwner("https://collector.example.test", "chatgpt-b");
	const secondIssuer = await formalResearchOwner("https://other.example.test", "chatgpt-a");
	assert.match(first, /^oauth-client:[a-f0-9]{64}$/);
	assert.equal(first, same);
	assert.notEqual(first, secondClient);
	assert.notEqual(first, secondIssuer);
});
