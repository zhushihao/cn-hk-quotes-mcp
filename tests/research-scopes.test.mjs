import assert from "node:assert/strict";
import test from "node:test";

const {
	permitsFormalResearchOperation,
	resolveResearchPrincipal,
	resolveResearchIssuer,
	formalResearchOwner,
} = await import("../src/research-scopes.ts");

// Issue #19: formal authorization binds to the stable business principal plus
// the required research scope.  The dynamic OAuth (DCR) client_id and the
// job_id format are NOT authorization inputs; job eligibility is decided
// server-side by record/lease state.
test("formal gate requires stable principal + issuer + exact scope, independent of job id", () => {
	const base = {
		principal: "chatgpt-production",
		issuer: "https://collector.example.test",
		scopes: new Set(["research:claim", "research:submit"]),
		requiredScope: "research:claim",
	};
	assert.equal(permitsFormalResearchOperation({ ...base }), true);
	for (const principal of ["codex", "engineering", "producer", "receipt-reader"]) {
		assert.equal(permitsFormalResearchOperation({ ...base, principal }), false, principal);
	}
	assert.equal(permitsFormalResearchOperation({ ...base, principal: null }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, issuer: null }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, scopes: new Set() }), false);
});

test("market:read alone can never claim or submit (no scope implication)", () => {
	const base = {
		principal: "chatgpt-production",
		issuer: "https://collector.example.test",
		scopes: new Set(["market:read"]),
	};
	assert.equal(permitsFormalResearchOperation({ ...base, requiredScope: "research:claim" }), false);
	assert.equal(permitsFormalResearchOperation({ ...base, requiredScope: "research:submit" }), false);
	// Partial grants fail closed on the missing side only.
	assert.equal(
		permitsFormalResearchOperation({
			...base,
			scopes: new Set(["market:read", "research:claim"]),
			requiredScope: "research:submit",
		}),
		false,
	);
	assert.equal(
		permitsFormalResearchOperation({
			...base,
			scopes: new Set(["market:read", "research:submit"]),
			requiredScope: "research:claim",
		}),
		false,
	);
});

test("stable principal is credential-bound on the bridge path and survives DCR rotation", async () => {
	const bridgeToken = "synthetic-bridge-token";
	// The same stable principal is accepted no matter which dynamic client
	// registered — the DCR client_id is not an input anywhere.
	assert.equal(resolveResearchPrincipal(`Bearer ${bridgeToken}`, "chatgpt-production", bridgeToken), "chatgpt-production");
	assert.equal(resolveResearchPrincipal("Bearer wrong", "chatgpt-production", bridgeToken), null);
	assert.equal(resolveResearchPrincipal(null, "chatgpt-production", bridgeToken), null);
	assert.equal(resolveResearchPrincipal(`Bearer ${bridgeToken}`, "../etc-passwd", bridgeToken), null);
	assert.equal(resolveResearchPrincipal(`Bearer ${bridgeToken}`, "x".repeat(257), bridgeToken), null);
	assert.equal(resolveResearchIssuer(`Bearer ${bridgeToken}`, "https://collector.example.test", bridgeToken), "https://collector.example.test");
	assert.equal(resolveResearchIssuer(`Bearer ${bridgeToken}`, "https://collector.example.test/not-an-issuer", bridgeToken), null);
	// Lease owner binds issuer + principal: identical across DCR client_id
	// changes, distinct across principals/issuers.
	const first = await formalResearchOwner("https://collector.example.test", "chatgpt-production");
	const same = await formalResearchOwner("https://collector.example.test", "chatgpt-production");
	const otherPrincipal = await formalResearchOwner("https://collector.example.test", "chatgpt-staging");
	const otherIssuer = await formalResearchOwner("https://other.example.test", "chatgpt-production");
	assert.match(first, /^oauth-client:[a-f0-9]{64}$/);
	assert.equal(first, same, "DCR re-registration must not move the lease owner");
	assert.notEqual(first, otherPrincipal);
	assert.notEqual(first, otherIssuer);
});
