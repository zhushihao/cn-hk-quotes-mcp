import assert from "node:assert/strict";
import test from "node:test";

const { permitsFormalResearchOperation } = await import("../src/research-scopes.ts");

test("formal MCP entry requires authenticated allowed client, scope, and namespace", () => {
	const base = {
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
	assert.equal(permitsFormalResearchOperation({ ...base, clientId: "chatgpt-production", jobId: "synthetic:job-1" }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, clientId: "chatgpt-production", scopes: new Set() }), false);
});
