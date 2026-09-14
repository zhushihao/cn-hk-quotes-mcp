import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

test("OAuth state is stored in an isolated D1 table instead of account-wide Workers KV", async () => {
	const wrangler = await source("../wrangler.jsonc");
	const oauth = await source("../src/oauth-entry.ts");
	const diagnostics = await source("../src/oauth-diagnostics-entry.ts");
	const adapter = await source("../src/d1-oauth-kv.ts");
	assert.match(wrangler, /"main": "src\/oauth-diagnostics-entry\.ts"/);
	assert.match(diagnostics, /import oauthWorker from "\.\/oauth-entry"/);
	assert.match(diagnostics, /oauthWorker\.fetch\(request, env, ctx\)/);
	assert.match(wrangler, /"binding": "RESEARCH_REPLICA"/);
	assert.match(wrangler, /"binding": "PORTFOLIO_UNIVERSE"/);
	assert.doesNotMatch(wrangler, /"binding": "OAUTH_KV"/);
	assert.match(oauth, /OAUTH_KV: createD1OAuthKv\(env\.RESEARCH_REPLICA\)/);
	assert.match(oauth, /RESEARCH_REPLICA D1 binding is required for OAuth storage/);
	assert.doesNotMatch(oauth, /OAUTH_KV: env\.PORTFOLIO_UNIVERSE/);
	assert.match(adapter, /OAUTH_TABLE = "oauth_kv_v1"/);
	assert.match(adapter, /ON CONFLICT\(kv_key\) DO UPDATE/);
	assert.match(adapter, /list_complete:/);
});

test("LIVE universe remains on its original KV keyspace and is not used as OAuth persistence", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const liveUniverse = await source("../src/live-universe.ts");
	const portfolioStatus = await source("../src/portfolio-status.ts");
	const portfolioDelta = await source("../src/portfolio-delta.ts");
	assert.doesNotMatch(oauth, /createD1OAuthKv\(env\.PORTFOLIO_UNIVERSE/);
	assert.match(liveUniverse, /LIVE_UNIVERSE_KV_KEY = "live-portfolio\/current"/);
	assert.match(portfolioStatus, /PORTFOLIO_STATUS_KV_KEY = "live-portfolio\/status"/);
	assert.match(portfolioDelta, /PORTFOLIO_UNIVERSE_BASELINE_KV_KEY = "live-portfolio\/private\//);
	assert.match(portfolioDelta, /PORTFOLIO_UNIVERSE_DELTA_KV_KEY = "live-portfolio\/private\//);
});

test("temporary production storage diagnostic is removed after identifying the KV daily quota root cause", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.doesNotMatch(oauth, /STORAGE_SMOKE_USER_AGENT/);
	assert.doesNotMatch(oauth, /probePortfolioUniverseWrite/);
	assert.doesNotMatch(oauth, /PORTFOLIO_UNIVERSE_DIRECT/);
	assert.doesNotMatch(oauth, /OAUTH_PROVIDER_DCR/);
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

test("ChatGPT issuer compatibility omits RFC 9207 advertisement and strips iss only from ChatGPT connector callbacks", async () => {
	const diagnostics = await source("../src/oauth-diagnostics-entry.ts");
	assert.match(
		diagnostics,
		/OAUTH_SERVER_METADATA_PATH = "\/\.well-known\/oauth-authorization-server"/,
	);
	assert.match(diagnostics, /delete metadata\.authorization_response_iss_parameter_supported/);
	assert.match(
		diagnostics,
		/response = await applyIssuerAdvertisementCompat\(request, response\)/,
	);
	assert.match(diagnostics, /function applyChatGptCallbackIssuerCompat/);
	assert.match(diagnostics, /redirect\.hostname === "chatgpt\.com"/);
	assert.match(diagnostics, /redirect\.pathname\.startsWith\("\/connector\/oauth\/"\)/);
	assert.match(diagnostics, /redirect\.searchParams\.delete\("iss"\)/);
	assert.match(
		diagnostics,
		/if \(authorizePost\) response = applyChatGptCallbackIssuerCompat\(response\)/,
	);
	assert.match(diagnostics, /iss_present: url\.searchParams\.has\("iss"\)/);
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
	assert.match(oauth, /const ownerSecret = env\.COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(oauth, /constantTimeSecretEquals\(ownerKey, ownerSecret\)/);
	assert.doesNotMatch(oauth, /console\.(?:log|warn|error).*COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.doesNotMatch(oauth, /props:\s*\{[^}]*ownerKey/s);
});

test("internal universe credential remains outside the OAuth adapter", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	const runtimeStart = oauth.indexOf("function oauthRuntimeEnv");
	const runtimeEnd = oauth.indexOf("function escapeHtml", runtimeStart);
	const runtime = oauth.slice(runtimeStart, runtimeEnd);
	assert.match(runtime, /createD1OAuthKv\(env\.RESEARCH_REPLICA\)/);
	assert.doesNotMatch(runtime, /PORTFOLIO_UNIVERSE_TOKEN/);
	assert.doesNotMatch(runtime, /env\.PORTFOLIO_UNIVERSE/);
	const core = await source("../src/index.ts");
	const internalStart = core.indexOf("function requestInternalUniverseStatus");
	const internalEnd = core.indexOf("function requestMcpMarketReadStatus", internalStart);
	assert.match(core.slice(internalStart, internalEnd), /PORTFOLIO_UNIVERSE_TOKEN/);
});

test("OAuth owner authorization uses a signed cookie-independent form token", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.match(oauth, /async function createAuthFormToken/);
	assert.match(oauth, /async function validateAuthFormToken/);
	assert.match(oauth, /name: "HMAC", hash: "SHA-256"/);
	assert.match(oauth, /AUTH_FORM_MAX_AGE_SECONDS = 10 \* 60/);
	assert.doesNotMatch(oauth, /CSRF_COOKIE/);
	assert.doesNotMatch(oauth, /parseCookies/);
	assert.doesNotMatch(oauth, /Set-Cookie/);
	assert.match(oauth, /授权会话已过期或无效/);
	assert.match(oauth, /授权密钥不匹配/);
});

test("OAuth authorization stays market-read only", async () => {
	const oauth = await source("../src/oauth-entry.ts");
	assert.match(oauth, /if \(!requested\.has\(MARKET_READ_SCOPE\)\) return null/);
	assert.match(oauth, /scope: scopes/);
	assert.match(oauth, /userId: OWNER_USER_ID/);
	assert.match(oauth, /不会授予交易、撤单、账户、成本或订单权限/);
});
