import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCE = "https://cn-hk-quotes-mcp.zhushihao710.workers.dev/mcp";
const OWNER_SECRET = "synthetic-owner-secret";
const REDIRECT_URI = "http://127.0.0.1:8799/callback";
const VERIFIER = "synthetic-verifier-for-pkce-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MCP_HEADERS = {
	accept: "application/json, text/event-stream",
	"content-type": "application/json",
	"mcp-protocol-version": "2025-03-26",
};

async function availablePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const { port } = address;
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

async function waitForWorker(origin, stderr, requireOk = true) {
	let lastError = "not started";
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(`${origin}/.well-known/oauth-authorization-server`);
			if (response.ok || !requireOk) return;
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`local Worker did not become ready: ${lastError}; stderr=${stderr()}`);
}

async function stop(child) {
	if (child.exitCode !== null || child.killed) return;
	if (process.platform === "win32") {
		const taskkill = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		await new Promise((resolve) => taskkill.once("exit", resolve));
	} else {
		child.kill("SIGTERM");
	}
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 5_000)),
	]);
	if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
}

async function startWorker({ withoutD1 = false } = {}) {
	const temp = await mkdtemp(path.join(tmpdir(), "quantpro-oauth-lifecycle-"));
	const port = await availablePort();
	const envFile = path.join(temp, ".dev.vars");
	const stateDir = path.join(temp, "state");
	await writeFile(
		envFile,
		[
			`COLLECTOR_MCP_CLIENT_TOKEN=${OWNER_SECRET}`,
			"COLLECTOR_MCP_CLIENT_ID=chatgpt-production",
			"COLLECTOR_MCP_CLIENT_SCOPES=market:read",
			"PORTFOLIO_UNIVERSE_TOKEN=synthetic-internal-secret",
			"GITHUB_TOKEN=synthetic-github-token",
		].join("\n"),
	);
	let configPath = "wrangler.jsonc";
	if (withoutD1) {
		configPath = path.join(temp, "wrangler.no-d1.jsonc");
		await writeFile(
			configPath,
			JSON.stringify({
				name: "cn-hk-quotes-mcp-oauth-no-d1-test",
				main: path.join(ROOT, "src", "oauth-diagnostics-entry.ts"),
				compatibility_date: "2026-07-02",
				compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
				kv_namespaces: [{ binding: "PORTFOLIO_UNIVERSE" }],
			}),
		);
	}
	const stderrLines = [];
	const child = spawn(
		process.execPath,
		[
			path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
			"dev",
			"--config",
			configPath,
			"--local",
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
			"--persist-to",
			stateDir,
			"--env-file",
			envFile,
			"--log-level",
			"error",
		],
		{
			cwd: ROOT,
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		},
	);
	child.stderr.on("data", (chunk) => {
		stderrLines.push(String(chunk));
		if (stderrLines.length > 20) stderrLines.shift();
	});
	const origin = `http://127.0.0.1:${port}`;
	try {
		await waitForWorker(origin, () => stderrLines.join("").slice(-4_000), !withoutD1);
	} catch (error) {
		await stop(child);
		await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		throw error;
	}
	return {
		origin,
		async close() {
			await stop(child);
			await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		},
	};
}

function pkceChallenge(verifier = VERIFIER) {
	return createHash("sha256").update(verifier).digest("base64url");
}

async function postForm(origin, pathname, form, options = {}) {
	return fetch(`${origin}${pathname}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(options.headers ?? {}),
		},
		body: new URLSearchParams(form),
		redirect: options.redirect ?? "manual",
	});
}

async function registerClient(origin) {
	const response = await fetch(`${origin}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Synthetic OAuth lifecycle client",
			redirect_uris: [REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	assert.equal(response.status, 201, "DCR must issue a local synthetic client");
	const client = await response.json();
	assert.equal(typeof client.client_id, "string");
	return client;
}

function authorizePath(clientId, overrides = {}) {
	const parameters = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: "market:read offline_access",
		state: "synthetic-state",
		code_challenge: pkceChallenge(),
		code_challenge_method: "S256",
		resource: RESOURCE,
		...overrides,
	});
	return `/authorize?${parameters}`;
}

async function beginAuthorization(origin, clientId, overrides = {}) {
	const pathname = authorizePath(clientId, overrides);
	const response = await fetch(`${origin}${pathname}`);
	assert.equal(response.status, 200, "authorize GET must render the owner form");
	const html = await response.text();
	const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1];
	assert.ok(csrf, "owner form must carry a signed CSRF value");
	return { pathname, csrf };
}

async function approve(origin, authorization, ownerKey = OWNER_SECRET) {
	return postForm(origin, authorization.pathname, {
		csrf: authorization.csrf,
		owner_key: ownerKey,
	});
}

async function issueAuthorizationCode(origin, clientId) {
	const authorization = await beginAuthorization(origin, clientId);
	const response = await approve(origin, authorization);
	assert.equal(response.status, 302, "valid owner consent must return a callback redirect");
	const location = response.headers.get("location");
	assert.ok(location, "authorization response must carry callback Location");
	const callback = new URL(location);
	assert.equal(callback.origin, new URL(REDIRECT_URI).origin);
	assert.equal(callback.pathname, "/callback");
	assert.equal(callback.searchParams.get("state"), "synthetic-state");
	const code = callback.searchParams.get("code");
	assert.ok(code, "callback must carry an authorization code");
	assert.equal(
		location.includes(OWNER_SECRET),
		false,
		"callback must not contain owner form data",
	);
	return code;
}

async function exchangeCode(origin, clientId, code, overrides = {}) {
	return postForm(origin, "/oauth/token", {
		grant_type: "authorization_code",
		client_id: clientId,
		code,
		redirect_uri: REDIRECT_URI,
		code_verifier: VERIFIER,
		resource: RESOURCE,
		...overrides,
	});
}

async function initializeMcp(origin, accessToken) {
	return fetch(`${origin}/mcp`, {
		method: "POST",
		headers: { ...MCP_HEADERS, authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "local-oauth-lifecycle", version: "1" },
			},
		}),
	});
}

test("local Worker closes DCR → consent → PKCE → token → refresh → authenticated MCP", async (t) => {
	const worker = await startWorker();
	t.after(() => worker.close());

	const [metadataResponse, resourceResponse] = await Promise.all([
		fetch(`${worker.origin}/.well-known/oauth-authorization-server`),
		fetch(`${worker.origin}/.well-known/oauth-protected-resource/mcp`),
	]);
	assert.equal(metadataResponse.status, 200);
	assert.equal(resourceResponse.status, 200);
	const metadata = await metadataResponse.json();
	const resource = await resourceResponse.json();
	assert.equal(metadata.issuer, worker.origin);
	assert.ok(metadata.scopes_supported.includes("market:read"));
	assert.ok(metadata.scopes_supported.includes("offline_access"));
	assert.equal(resource.resource, RESOURCE);

	const client = await registerClient(worker.origin);
	const code = await issueAuthorizationCode(worker.origin, client.client_id);
	const tokenResponse = await exchangeCode(worker.origin, client.client_id, code);
	assert.equal(tokenResponse.status, 200, "PKCE code exchange must succeed");
	const tokens = await tokenResponse.json();
	assert.equal(typeof tokens.access_token, "string");
	assert.equal(typeof tokens.refresh_token, "string");
	assert.match(tokens.scope, /market:read/);

	const mcp = await initializeMcp(worker.origin, tokens.access_token);
	assert.equal(mcp.status, 200, "OAuth Bearer must reach MCP");
	assert.equal(mcp.headers.has("www-authenticate"), false);
	assert.ok((await mcp.text()).includes('"result"'));

	const refreshResponse = await postForm(worker.origin, "/oauth/token", {
		grant_type: "refresh_token",
		client_id: client.client_id,
		refresh_token: tokens.refresh_token,
		resource: RESOURCE,
	});
	assert.equal(refreshResponse.status, 200, "refresh-token exchange must succeed");
	const refreshed = await refreshResponse.json();
	assert.equal(typeof refreshed.access_token, "string");
	const mcpAfterRefresh = await initializeMcp(worker.origin, refreshed.access_token);
	assert.equal(mcpAfterRefresh.status, 200, "refreshed Bearer must reach MCP");
	assert.ok((await mcpAfterRefresh.text()).includes('"result"'));

	const reused = await exchangeCode(worker.origin, client.client_id, code);
	assert.equal(reused.status, 400, "authorization codes must not be reusable");

	const wrongPkceCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(
			await exchangeCode(worker.origin, client.client_id, wrongPkceCode, {
				code_verifier: "wrong",
			})
		).status,
		400,
		"wrong PKCE verifier must fail closed",
	);
	const wrongRedirectCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(
			await exchangeCode(worker.origin, client.client_id, wrongRedirectCode, {
				redirect_uri: "http://127.0.0.1:8799/wrong",
			})
		).status,
		400,
		"wrong redirect URI must fail closed",
	);
	const wrongClientCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(await exchangeCode(worker.origin, "wrong-client", wrongClientCode)).status,
		401,
		"wrong client ID must fail closed",
	);
	const wrongAudienceCode = await issueAuthorizationCode(worker.origin, client.client_id);
	assert.equal(
		(
			await exchangeCode(worker.origin, client.client_id, wrongAudienceCode, {
				resource: "https://example.test/mcp",
			})
		).status,
		400,
		"wrong resource/audience must fail closed",
	);

	const missingScope = await fetch(
		`${worker.origin}${authorizePath(client.client_id, { scope: "offline_access" })}`,
	);
	assert.equal(missingScope.status, 400, "market:read must be mandatory");
	const invalidForm = await beginAuthorization(worker.origin, client.client_id);
	assert.equal(
		(
			await postForm(worker.origin, invalidForm.pathname, {
				csrf: "invalid",
				owner_key: OWNER_SECRET,
			})
		).status,
		400,
		"invalid signed form state must fail closed",
	);
	const wrongOwner = await beginAuthorization(worker.origin, client.client_id);
	assert.equal((await approve(worker.origin, wrongOwner, "wrong-owner-key")).status, 401);

	const malformedBearer = await initializeMcp(worker.origin, "not-a-valid-or-current-token");
	assert.equal(malformedBearer.status, 401, "malformed or expired-like Bearer must fail closed");
	assert.match(malformedBearer.headers.get("www-authenticate") ?? "", /Bearer/);
	assert.equal(
		(
			await postForm(worker.origin, "/oauth/token", {
				grant_type: "refresh_token",
				client_id: client.client_id,
				refresh_token: "invalid-refresh-token",
				resource: RESOURCE,
			})
		).status,
		400,
		"invalid refresh token must fail closed",
	);
});

test("missing local D1 OAuth persistence fails closed before authorization", async (t) => {
	const worker = await startWorker({ withoutD1: true });
	t.after(() => worker.close());
	const response = await fetch(`${worker.origin}/authorize`);
	assert.ok(
		response.status >= 500,
		"unavailable D1 persistence must not issue an authorization form",
	);
	assert.equal(response.headers.has("location"), false);
});
