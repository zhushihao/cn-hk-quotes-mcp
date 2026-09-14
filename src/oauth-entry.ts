import OAuthProvider, {
	type AuthRequest,
	type OAuthHelpers,
	type TokenSummary,
} from "@cloudflare/workers-oauth-provider";

import coreWorker from "./index";

const ORIGIN = "https://cn-hk-quotes-mcp.zhushihao710.workers.dev";
const MCP_RESOURCE = `${ORIGIN}/mcp`;
const MARKET_READ_SCOPE = "market:read";
const OFFLINE_ACCESS_SCOPE = "offline_access";
const OWNER_USER_ID = "quantpro-owner";
const CSRF_COOKIE = "qp_oauth_csrf";
const MAX_OWNER_KEY_LENGTH = 512;
const STORAGE_SMOKE_USER_AGENT = "quantpro-prod-oauth-storage-smoke/1";

type CoreEnv = Parameters<typeof coreWorker.fetch>[1];
type OAuthProps = {
	principal: string;
	scopes: string[];
};
type OAuthEnv = CoreEnv & {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
};

type StorageProbeResult = {
	ok: boolean;
	stage: "PORTFOLIO_UNIVERSE_DIRECT" | "OAUTH_PROVIDER_DCR";
	error_name?: string;
	error_message?: string;
};

function oauthRuntimeEnv(env: CoreEnv): OAuthEnv {
	if (!env.PORTFOLIO_UNIVERSE) {
		throw new Error("PORTFOLIO_UNIVERSE KV binding is required for OAuth storage");
	}
	return { ...env, OAUTH_KV: env.PORTFOLIO_UNIVERSE } as OAuthEnv;
}

function diagnosticError(error: unknown): Pick<StorageProbeResult, "error_name" | "error_message"> {
	if (error instanceof Error) {
		return {
			error_name: error.name.slice(0, 80),
			error_message: error.message.replace(/[\r\n]+/gu, " ").slice(0, 300),
		};
	}
	return { error_name: "UnknownError", error_message: String(error).slice(0, 300) };
}

async function probePortfolioUniverseWrite(env: CoreEnv): Promise<StorageProbeResult> {
	if (!env.PORTFOLIO_UNIVERSE) {
		return {
			ok: false,
			stage: "PORTFOLIO_UNIVERSE_DIRECT",
			error_name: "MissingBinding",
			error_message: "PORTFOLIO_UNIVERSE is not bound",
		};
	}
	const key = `oauth-health:${crypto.randomUUID()}`;
	try {
		await env.PORTFOLIO_UNIVERSE.put(key, "1", { expirationTtl: 60 });
		const stored = await env.PORTFOLIO_UNIVERSE.get(key);
		await env.PORTFOLIO_UNIVERSE.delete(key);
		if (stored !== "1") {
			return {
				ok: false,
				stage: "PORTFOLIO_UNIVERSE_DIRECT",
				error_name: "ReadAfterWriteMismatch",
				error_message: "KV read-after-write did not return the probe value",
			};
		}
		return { ok: true, stage: "PORTFOLIO_UNIVERSE_DIRECT" };
	} catch (error) {
		return { ok: false, stage: "PORTFOLIO_UNIVERSE_DIRECT", ...diagnosticError(error) };
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function randomBase64Url(bytes = 24): string {
	const raw = crypto.getRandomValues(new Uint8Array(bytes));
	let binary = "";
	for (const byte of raw) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function parseCookies(request: Request): Map<string, string> {
	const result = new Map<string, string>();
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
	}
	return result;
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeSecretEquals(
	candidate: string,
	configured: string | undefined,
): Promise<boolean> {
	if (!configured || !candidate || candidate.length > MAX_OWNER_KEY_LENGTH) return false;
	const [left, right] = await Promise.all([sha256(candidate), sha256(configured)]);
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
	return difference === 0;
}

function audienceMatches(audience: string | string[] | undefined): boolean {
	if (typeof audience === "string") return audience === MCP_RESOURCE;
	return Array.isArray(audience) && audience.includes(MCP_RESOURCE);
}

function resourceMetadataUrl(request: Request): string {
	return new URL("/.well-known/oauth-protected-resource/mcp", request.url).toString();
}

function oauthChallenge(request: Request, error = "invalid_token", status = 401): Response {
	const challenge = [
		"Bearer",
		`resource_metadata="${resourceMetadataUrl(request)}"`,
		`scope="${MARKET_READ_SCOPE}"`,
		`error="${error}"`,
	].join(" ");
	return new Response(JSON.stringify({ error }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"WWW-Authenticate": challenge,
		},
	});
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (!authorization) return null;
	if (!authorization.startsWith("Bearer ")) return "";
	const token = authorization.slice("Bearer ".length);
	return token.length > 0 ? token : "";
}

function withAuthorization(request: Request, authorization: string | null): Request {
	const headers = new Headers(request.headers);
	if (authorization === null) headers.delete("Authorization");
	else headers.set("Authorization", authorization);
	return new Request(request, { headers });
}

function validRequestedScopes(authRequest: AuthRequest): string[] | null {
	const requested = new Set(authRequest.scope);
	if (!requested.has(MARKET_READ_SCOPE)) return null;
	for (const scope of requested) {
		if (scope !== MARKET_READ_SCOPE && scope !== OFFLINE_ACCESS_SCOPE) return null;
	}
	return [...requested];
}

function authorizationPage(options: {
	action: string;
	clientName: string;
	scopes: string[];
	csrf: string;
	error?: string;
}): string {
	const scopeList = options.scopes
		.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
		.join("");
	const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : "";
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuantPro Collector 授权</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#111;margin:0;padding:32px}
main{max-width:560px;margin:8vh auto;background:#fff;border:1px solid #ddd;border-radius:14px;padding:28px;box-shadow:0 8px 28px #0001}
h1{margin-top:0;font-size:24px}.muted{color:#666}.error{background:#fff0f0;color:#9b1c1c;padding:10px;border-radius:8px}
input{box-sizing:border-box;width:100%;padding:11px;margin:8px 0 18px;border:1px solid #aaa;border-radius:8px}button{padding:11px 16px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}
code{background:#f1f2f4;padding:2px 5px;border-radius:4px}
</style>
</head>
<body><main>
<h1>授权 QuantPro Collector</h1>
<p>客户端：<strong>${escapeHtml(options.clientName)}</strong></p>
<p class="muted">仅授权只读行情能力。不会授予交易、撤单、账户、成本或订单权限。</p>
<ul>${scopeList}</ul>${error}
<form method="post" action="${escapeHtml(options.action)}" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<label for="owner_key">QuantPro Collector 授权密钥</label>
<input id="owner_key" name="owner_key" type="password" required maxlength="${MAX_OWNER_KEY_LENGTH}" autocomplete="off">
<button type="submit">授权只读访问</button>
</form>
</main></body></html>`;
}

async function parseAuthorizationRequest(
	request: Request,
	env: OAuthEnv,
): Promise<AuthRequest | Response> {
	try {
		const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		if (!validRequestedScopes(authRequest)) {
			return new Response("OAuth scope request is not permitted", { status: 400 });
		}
		return authRequest;
	} catch {
		return new Response("Invalid OAuth authorization request", { status: 400 });
	}
}

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const parsed = await parseAuthorizationRequest(request, env);
	if (parsed instanceof Response) return parsed;
	const scopes = validRequestedScopes(parsed)!;
	const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
	const clientName = client?.clientName || "ChatGPT";
	const url = new URL(request.url);
	const action = `${url.pathname}${url.search}`;

	if (request.method === "GET") {
		const csrf = randomBase64Url();
		return new Response(authorizationPage({ action, clientName, scopes, csrf }), {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Set-Cookie": `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=600`,
				"Content-Security-Policy":
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
				"Referrer-Policy": "no-referrer",
			},
		});
	}

	const form = await request.formData();
	const csrf = String(form.get("csrf") ?? "");
	const cookieCsrf = parseCookies(request).get(CSRF_COOKIE) ?? "";
	const ownerKey = String(form.get("owner_key") ?? "");
	const csrfOk = csrf.length >= 20 && cookieCsrf.length >= 20 && csrf === cookieCsrf;
	const ownerOk = await constantTimeSecretEquals(ownerKey, env.COLLECTOR_MCP_CLIENT_TOKEN);
	if (!csrfOk || !ownerOk) {
		const nextCsrf = randomBase64Url();
		return new Response(
			authorizationPage({
				action,
				clientName,
				scopes,
				csrf: nextCsrf,
				error: "授权信息无效，请重试。",
			}),
			{
				status: 401,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Set-Cookie": `${CSRF_COOKIE}=${nextCsrf}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=600`,
					"Content-Security-Policy":
						"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
					"Referrer-Policy": "no-referrer",
				},
			},
		);
	}

	const principal = env.COLLECTOR_MCP_CLIENT_ID?.trim() || "chatgpt-production";
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: parsed,
		userId: OWNER_USER_ID,
		metadata: { principal, capability: MARKET_READ_SCOPE },
		scope: scopes,
		props: { principal, scopes } satisfies OAuthProps,
	});
	return new Response(null, {
		status: 302,
		headers: {
			Location: redirectTo,
			"Cache-Control": "no-store",
			"Set-Cookie": `${CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0`,
		},
	});
}

function tokenHasMarketRead(summary: TokenSummary<OAuthProps>): boolean {
	return (
		summary.userId === OWNER_USER_ID &&
		audienceMatches(summary.audience) &&
		summary.scope.includes(MARKET_READ_SCOPE) &&
		summary.grant.props?.principal === "chatgpt-production" &&
		Array.isArray(summary.grant.props?.scopes) &&
		summary.grant.props.scopes.includes(MARKET_READ_SCOPE)
	);
}

async function handleMcp(
	request: Request,
	env: OAuthEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const token = bearerToken(request);
	if (token === null) {
		return coreWorker.fetch(withAuthorization(request, null), env, ctx);
	}
	if (!token) return oauthChallenge(request);

	let summary: TokenSummary<OAuthProps> | null = null;
	try {
		summary = await env.OAUTH_PROVIDER.unwrapToken<OAuthProps>(token);
	} catch {
		return oauthChallenge(request);
	}
	if (!summary) return oauthChallenge(request);
	if (!summary.scope.includes(MARKET_READ_SCOPE)) {
		return oauthChallenge(request, "insufficient_scope", 403);
	}
	if (!tokenHasMarketRead(summary)) return oauthChallenge(request);

	const bridgeSecret = env.COLLECTOR_MCP_CLIENT_TOKEN;
	const forwarded = withAuthorization(request, bridgeSecret ? `Bearer ${bridgeSecret}` : null);
	return coreWorker.fetch(forwarded, env, ctx);
}

const defaultHandler: ExportedHandler<OAuthEnv> = {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/authorize") return handleAuthorize(request, env);
		if (url.pathname === "/mcp") return handleMcp(request, env, ctx);
		return coreWorker.fetch(request, env, ctx);
	},
};

const unusedProtectedHandler = {
	fetch() {
		return new Response("Not Found", { status: 404 });
	},
};

const oauthProvider = new OAuthProvider<OAuthEnv>({
	apiRoute: "/__oauth_provider_protected",
	apiHandler: unusedProtectedHandler,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	accessTokenTTL: 60 * 60,
	refreshTokenTTL: 90 * 24 * 60 * 60,
	clientRegistrationTTL: 90 * 24 * 60 * 60,
	scopesSupported: [MARKET_READ_SCOPE, OFFLINE_ACCESS_SCOPE],
	allowImplicitFlow: false,
	allowPlainPKCE: false,
	clientIdMetadataDocumentEnabled: true,
	resourceMetadata: {
		resource: MCP_RESOURCE,
		authorization_servers: [ORIGIN],
		scopes_supported: [MARKET_READ_SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "QuantPro Collector",
	},
	tokenExchangeCallback({ requestedScope, props, clientId }) {
		const principal = "chatgpt-production";
		return {
			accessTokenProps: {
				...(props && typeof props === "object" ? props : {}),
				principal,
				clientId,
				scopes: requestedScope,
			},
			accessTokenScope: requestedScope,
		};
	},
});

export default {
	async fetch(request: Request, env: CoreEnv, ctx: ExecutionContext) {
		const runtimeEnv = oauthRuntimeEnv(env);
		const isStorageSmoke =
			new URL(request.url).pathname === "/oauth/register" &&
			request.method === "POST" &&
			request.headers.get("User-Agent") === STORAGE_SMOKE_USER_AGENT;
		if (isStorageSmoke) {
			const directProbe = await probePortfolioUniverseWrite(env);
			if (!directProbe.ok) {
				return Response.json(directProbe, { status: 500 });
			}
			try {
				return await oauthProvider.fetch(request, runtimeEnv, ctx);
			} catch (error) {
				return Response.json(
					{
						ok: false,
						stage: "OAUTH_PROVIDER_DCR",
						...diagnosticError(error),
					} satisfies StorageProbeResult,
					{ status: 500 },
				);
			}
		}
		return oauthProvider.fetch(request, runtimeEnv, ctx);
	},
	async scheduled(controller: ScheduledController, env: CoreEnv, ctx: ExecutionContext) {
		const runtimeEnv = oauthRuntimeEnv(env);
		await coreWorker.scheduled(controller, env);
		ctx.waitUntil(
			oauthProvider
				.purgeExpiredData(runtimeEnv, { batchSize: 25 })
				.then(() => undefined)
				.catch(() => undefined),
		);
	},
} satisfies ExportedHandler<CoreEnv>;