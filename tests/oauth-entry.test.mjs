import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

test("wrangler routes production through OAuth entrypoint with isolated OAuth KV", async () => {
	const wrangler = await source("../wrangler.jsonc");
	assert.match(wrangler, /"main": "src\/oauth-entry\.ts"/);
	assert.match(wrangler, /"binding": "OAUTH_KV"/);
	assert.match(wrangler, /"binding": "PORTFOLIO_UNIVERSE"/);
});

test("OAuth discovery advertises market:read and offline refresh support with PKCE S256 only", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.match(oauth, /scopesSupported: \[MARKET_READ_SCOPE, OFFLINE_ACCESS_SCOPE\]/);
	assert.match(oauth, /scopes_supported: \[MARKET_READ_SCOPE\]/);
	assert.match(oauth, /clientIdMetadataDocumentEnabled: true/);
	assert.match(oauth, /allowImplicitFlow: false/);
	assert.match(oauth, /allowPlainPKCE: false/);
	assert.match(oauth, /refreshTokenTTL:/);
	assert.match(oauth, /clientRegistrationEndpoint: "\/oauth\/register"/);
	assert.match(oauth, /tokenEndpoint: "\/oauth\/token"/);
	assert.match(oauth, /authorizeEndpoint: "\/authorize"/);
});

test("anonymous MCP remains quote-only compatible while OAuth bearer is validated before core", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const mcpStart = oauth.indexOf("async function handleMcp");
	const mcpEnd = oauth.indexOf("const defaultHandler", mcpStart);
	const body = oauth.slice(mcpStart, mcpEnd);
	assert.match(
		body,
		/if \(token === null\)[\s\S]*coreWorker\.fetch\(withAuthorization\(request, null\)/,
	);
	assert.match(body, /OAUTH_PROVIDER\.unwrapToken<OAuthProps>\(token\)/);
	assert.match(body, /summary\.scope\.includes\(MARKET_READ_SCOPE\)/);
	assert.match(body, /tokenHasMarketRead\(summary\)/);
	const tokenGateStart = oauth.indexOf("function tokenHasMarketRead");
	const tokenGateEnd = oauth.indexOf("async function handleMcp", tokenGateStart);
	const tokenGate = oauth.slice(tokenGateStart, tokenGateEnd);
	assert.match(tokenGate, /audienceMatches\(summary\.audience\)/);
	assert.match(body, /bridgeSecret \? `Bearer \$\{bridgeSecret\}` : null/);
});

test("legacy static bearer cannot bypass OAuth at the public MCP route", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const mcpStart = oauth.indexOf("async function handleMcp");
	const mcpEnd = oauth.indexOf("const defaultHandler", mcpStart);
	const body = oauth.slice(mcpStart, mcpEnd);
	assert.match(body, /unwrapToken<OAuthProps>\(token\)/);
	assert.doesNotMatch(
		body,
		/request\.headers\.get\("Authorization"\) === `Bearer \$\{env\.COLLECTOR_MCP_CLIENT_TOKEN\}`/,
	);
	assert.doesNotMatch(body, /PORTFOLIO_UNIVERSE_TOKEN/);
});

test("owner secret stays out of rendered HTML, OAuth props and logs", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const pageStart = oauth.indexOf("function authorizationPage");
	const pageEnd = oauth.indexOf("async function parseAuthorizationRequest", pageStart);
	const page = oauth.slice(pageStart, pageEnd);
	assert.doesNotMatch(page, /COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(oauth, /constantTimeSecretEquals\(ownerKey, env\.COLLECTOR_MCP_CLIENT_TOKEN\)/);
	assert.doesNotMatch(oauth, /console\.(?:log|warn|error).*COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.doesNotMatch(oauth, /props:\s*\{[^}]*ownerKey/s);
});

test("internal universe credential remains outside the OAuth adapter", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.doesNotMatch(oauth, /PORTFOLIO_UNIVERSE_TOKEN/);
	const core = await source("../src/index.ts");
	const internalStart = core.indexOf("function requestInternalUniverseStatus");
	const internalEnd = core.indexOf("function requestMcpMarketReadStatus", internalStart);
	assert.match(core.slice(internalStart, internalEnd), /PORTFOLIO_UNIVERSE_TOKEN/);
});

test("OAuth authorization is owner-approved, CSRF protected and market-read only", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.match(oauth, /csrf === cookieCsrf/);
	assert.match(oauth, /HttpOnly; Secure; SameSite=Lax/);
	assert.match(oauth, /if \(!requested\.has\(MARKET_READ_SCOPE\)\) return null/);
	assert.match(oauth, /scope: scopes/);
	assert.match(oauth, /userId: OWNER_USER_ID/);
	assert.match(oauth, /不会授予交易、撤单、账户、成本或订单权限/);
});
