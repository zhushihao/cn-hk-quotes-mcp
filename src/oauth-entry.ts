import {
	OAuthProvider,
	type AuthRequest,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import collector from "./index";
import {
	MARKET_READ_SCOPE,
	OFFLINE_ACCESS_SCOPE,
	constantTimeEqual,
	cookieValue,
	decorateToolSecuritySchemes,
	escapeHtml,
	randomHex,
} from "./oauth-helpers";

const OAUTH_AUTHORIZE_PATH = "/authorize";
const OAUTH_TOKEN_PATH = "/oauth/token";
const OAUTH_REGISTER_PATH = "/oauth/register";
const MCP_PATH = "/mcp";
const CSRF_COOKIE = "__Host-qp_oauth_csrf";
const OWNER_PRINCIPAL = "quantpro-owner";
const OAUTH_AUTH_MODE = "OAUTH_2_1";
const OAUTH_REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;

interface CollectorEnv {
	GITHUB_TOKEN: string;
	PORTFOLIO_UNIVERSE?: KVNamespace;
	PORTFOLIO_UNIVERSE_TOKEN?: string;
	COLLECTOR_MCP_CLIENT_TOKEN?: string;
	COLLECTOR_MCP_CLIENT_ID?: string;
	COLLECTOR_MCP_CLIENT_SCOPES?: string;
	CF_ACCESS_CLIENT_ID?: string;
	CF_ACCESS_CLIENT_SECRET?: string;
	RESEARCH_REPLICA?: D1Database;
	RESEARCH_OBJECTS?: R2Bucket;
	RESEARCH_REPLICA_INGEST_TOKEN?: string;
}

interface OAuthProps {
	principal: string;
	oauthClientId: string;
	scopes: string[];
}

interface OAuthEnv extends CollectorEnv {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...headers,
		},
	});
}

function authorizationPageHeaders(): Headers {
	return new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		Pragma: "no-cache",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	});
}

function renderAuthorizationPage(options: {
	requestUrl: URL;
	csrfToken: string;
	clientName: string;
	error?: string;
}): Response {
	const { requestUrl, csrfToken, clientName, error } = options;
	const action = escapeHtml(`${requestUrl.pathname}${requestUrl.search}`);
	const safeClientName = escapeHtml(clientName);
	const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
	const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuantPro Collector 授权</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f5f5;color:#171717;margin:0;padding:40px 16px}.card{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6}.scope{background:#f6f8fa;border-radius:10px;padding:12px 14px;margin:18px 0}.scope code{font-weight:700}label{display:block;font-weight:650;margin-top:18px}input{box-sizing:border-box;width:100%;margin-top:8px;padding:12px;border:1px solid #bbb;border-radius:8px;font:inherit}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:650;cursor:pointer}.note{font-size:13px;color:#666}.error{background:#fff0f0;color:#9b1c1c;padding:10px 12px;border-radius:8px}
</style>
</head>
<body>
<main class="card">
<h1>授权 QuantPro Collector</h1>
<p><strong>${safeClientName}</strong> 请求读取 QuantPro LIVE 行情视图。</p>
<div class="scope">权限：<code>${MARKET_READ_SCOPE}</code><br>只读；不授予下单、撤单、账号、成本或订单权限。</div>
${errorBlock}
<form method="post" action="${action}">
<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
<label for="owner_key">QuantPro 授权密钥</label>
<input id="owner_key" name="owner_key" type="password" autocomplete="current-password" required autofocus>
<button type="submit">授权只读访问</button>
</form>
<p class="note">密钥只提交给 QuantPro Collector，不会写入 ChatGPT Prompt、Git、日志或响应。</p>
</main>
</body>
</html>`;
	return new Response(html, {
		status: error ? 401 : 200,
		headers: authorizationPageHeaders(),
	});
}

function oauthErrorRedirect(authRequest: AuthRequest, code: string, description: string): Response {
	const redirect = new URL(authRequest.redirectUri);
	redirect.searchParams.set("error", code);
	redirect.searchParams.set("error_description", description);
	redirect.searchParams.set("state", authRequest.state);
	if (authRequest.issuer) redirect.searchParams.set("iss", authRequest.issuer);
	return Response.redirect(redirect.toString(), 302);
}

function validRequestedScopes(scopes: string[]): boolean {
	return scopes.every((scope) => scope === MARKET_READ_SCOPE || scope === OFFLINE_ACCESS_SCOPE);
}

function grantedScopes(scopes: string[]): string[] {
	const result = new Set<string>();
	result.add(MARKET_READ_SCOPE);
	if (scopes.includes(OFFLINE_ACCESS_SCOPE)) result.add(OFFLINE_ACCESS_SCOPE);
	return Array.from(result);
}

async function parseAuthorizationRequest(
	request: Request,
	env: OAuthEnv,
): Promise<AuthRequest | Response> {
	try {
		return await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch {
		return new Response("Invalid OAuth authorization request", {
			status: 400,
			headers: authorizationPageHeaders(),
		});
	}
}

async function handleAuthorization(request: Request, env: OAuthEnv): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET, POST", "Cache-Control": "no-store" },
		});
	}
	if (!env.COLLECTOR_MCP_CLIENT_TOKEN) {
		return new Response("QuantPro OAuth owner credential is not configured", {
			status: 503,
			headers: authorizationPageHeaders(),
		});
	}

	const parsed = await parseAuthorizationRequest(request, env);
	if (parsed instanceof Response) return parsed;
	const authRequest = parsed;
	if (!validRequestedScopes(authRequest.scope)) {
		return oauthErrorRedirect(authRequest, "invalid_scope", "Unsupported scope requested");
	}

	let clientName = "ChatGPT";
	try {
		const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
		if (!client) {
			return oauthErrorRedirect(authRequest, "unauthorized_client", "Unknown OAuth client");
		}
		clientName = client.clientName || clientName;
	} catch {
		return oauthErrorRedirect(
			authRequest,
			"temporarily_unavailable",
			"OAuth client metadata unavailable",
		);
	}

	const url = new URL(request.url);
	if (request.method === "GET") {
		const csrfToken = randomHex(32);
		const response = renderAuthorizationPage({ requestUrl: url, csrfToken, clientName });
		response.headers.set(
			"Set-Cookie",
			`${CSRF_COOKIE}=${csrfToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
		);
		return response;
	}

	const form = await request.formData();
	const csrfForm = String(form.get("csrf") ?? "");
	const csrfCookie = cookieValue(request.headers.get("Cookie"), CSRF_COOKIE) ?? "";
	const ownerKey = String(form.get("owner_key") ?? "");
	if (!csrfForm || !csrfCookie || !constantTimeEqual(csrfForm, csrfCookie)) {
		const csrfToken = randomHex(32);
		const response = renderAuthorizationPage({
			requestUrl: url,
			csrfToken,
			clientName,
			error: "授权页面已过期，请重新开始连接。",
		});
		response.headers.set(
			"Set-Cookie",
			`${CSRF_COOKIE}=${csrfToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
		);
		return response;
	}
	if (!constantTimeEqual(ownerKey, env.COLLECTOR_MCP_CLIENT_TOKEN)) {
		const response = renderAuthorizationPage({
			requestUrl: url,
			csrfToken: csrfCookie,
			clientName,
			error: "授权密钥不正确。",
		});
		response.headers.set(
			"Set-Cookie",
			`${CSRF_COOKIE}=${csrfCookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
		);
		return response;
	}

	const scopes = grantedScopes(authRequest.scope);
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: authRequest,
		userId: OWNER_PRINCIPAL,
		metadata: { clientName },
		scope: scopes,
		props: {
			principal: env.COLLECTOR_MCP_CLIENT_ID?.trim() || "chatgpt-production",
			oauthClientId: authRequest.clientId,
			scopes,
		} satisfies OAuthProps,
		revokeExistingGrants: false,
	});
	return new Response(null, {
		status: 302,
		headers: {
			Location: redirectTo,
			"Cache-Control": "no-store",
			"Set-Cookie": `${CSRF_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
		},
	});
}

function staticBearerAuthorized(request: Request, env: CollectorEnv): boolean {
	if (!env.COLLECTOR_MCP_CLIENT_TOKEN) return false;
	const authorization = request.headers.get("Authorization") ?? "";
	return constantTimeEqual(authorization, `Bearer ${env.COLLECTOR_MCP_CLIENT_TOKEN}`);
}

function oauthPropsFromContext(ctx: ExecutionContext): OAuthProps | null {
	const props = (ctx as ExecutionContext & { props?: unknown }).props;
	if (!props || typeof props !== "object" || Array.isArray(props)) return null;
	const record = props as Record<string, unknown>;
	if (typeof record.principal !== "string" || typeof record.oauthClientId !== "string") return null;
	if (!Array.isArray(record.scopes) || !record.scopes.every((scope) => typeof scope === "string")) {
		return null;
	}
	return {
		principal: record.principal,
		oauthClientId: record.oauthClientId,
		scopes: record.scopes as string[],
	};
}

function auditOAuthPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const root = payload as Record<string, unknown>;
	const result = root.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) return payload;
	const content = (result as Record<string, unknown>).content;
	if (!Array.isArray(content)) return payload;
	for (const item of content) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (record.type !== "text" || typeof record.text !== "string") continue;
		try {
			const parsed = JSON.parse(record.text) as Record<string, unknown>;
			const control =
				parsed.control_plane_status && typeof parsed.control_plane_status === "object"
					? (parsed.control_plane_status as Record<string, unknown>)
					: parsed;
			const auth =
				control.market_read_auth && typeof control.market_read_auth === "object"
					? (control.market_read_auth as Record<string, unknown>)
					: null;
			if (auth?.authenticated === true) {
				auth.auth_mode = OAUTH_AUTH_MODE;
				auth.client_id = "chatgpt-production";
				auth.scopes = [MARKET_READ_SCOPE];
				record.text = JSON.stringify(parsed, null, 2);
			}
		} catch {
			// Non-JSON tool text remains byte-for-byte unchanged.
		}
	}
	return payload;
}

function decorateMcpPayload(payload: unknown, oauthAuthenticated: boolean): unknown {
	const decorated = decorateToolSecuritySchemes(payload);
	return oauthAuthenticated ? auditOAuthPayload(decorated) : decorated;
}

function transformSseLine(line: string, oauthAuthenticated: boolean): string {
	const match = line.match(/^(data:\s*)(.*?)(\r?)$/);
	if (!match) return line;
	try {
		const payload = JSON.parse(match[2]);
		return `${match[1]}${JSON.stringify(decorateMcpPayload(payload, oauthAuthenticated))}${match[3]}`;
	} catch {
		return line;
	}
}

function transformSseBody(body: ReadableStream<Uint8Array>, oauthAuthenticated: boolean) {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					controller.enqueue(
						encoder.encode(`${transformSseLine(line, oauthAuthenticated)}\n`),
					);
				}
			},
			flush(controller) {
				pending += decoder.decode();
				if (pending) {
					controller.enqueue(encoder.encode(transformSseLine(pending, oauthAuthenticated)));
				}
			},
		}),
	);
}

async function decorateMcpResponse(
	response: Response,
	oauthAuthenticated: boolean,
): Promise<Response> {
	const contentType = response.headers.get("Content-Type") ?? "";
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");

	if (contentType.includes("application/json")) {
		try {
			const payload = await response.json();
			return new Response(JSON.stringify(decorateMcpPayload(payload, oauthAuthenticated)), {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		} catch {
			return response;
		}
	}
	if (contentType.includes("text/event-stream") && response.body) {
		return new Response(transformSseBody(response.body, oauthAuthenticated), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
	return response;
}

async function delegateCollector(
	request: Request,
	env: CollectorEnv,
	ctx: ExecutionContext,
	oauthAuthenticated: boolean,
): Promise<Response> {
	const response = await collector.fetch(request, env as never, ctx);
	if (new URL(request.url).pathname !== MCP_PATH) return response;
	return decorateMcpResponse(response, oauthAuthenticated);
}

function makeOAuthProvider(
	request: Request,
	env: CollectorEnv,
): { provider: OAuthProvider<OAuthEnv>; oauthEnv: OAuthEnv } | null {
	if (!env.PORTFOLIO_UNIVERSE) return null;
	const origin = new URL(request.url).origin;
	const resource = `${origin}${MCP_PATH}`;
	const oauthEnv = {
		...env,
		OAUTH_KV: env.PORTFOLIO_UNIVERSE,
	} as OAuthEnv;

	const apiHandler: ExportedHandler<OAuthEnv> = {
		async fetch(apiRequest, apiEnv, apiCtx) {
			const props = oauthPropsFromContext(apiCtx);
			if (
				!props ||
				props.principal !== (apiEnv.COLLECTOR_MCP_CLIENT_ID?.trim() || "chatgpt-production")
			) {
				return jsonResponse({ error: "UNAUTHORIZED" }, 401);
			}
			if (!props.scopes.includes(MARKET_READ_SCOPE)) {
				return jsonResponse(
					{ error: "INSUFFICIENT_SCOPE" },
					403,
					{
						"WWW-Authenticate": `Bearer scope="${MARKET_READ_SCOPE}", error="insufficient_scope"`,
					},
				);
			}
			if (!apiEnv.COLLECTOR_MCP_CLIENT_TOKEN) {
				return jsonResponse({ error: "SERVER_AUTH_NOT_CONFIGURED" }, 503);
			}

			console.log(
				JSON.stringify({
					event: "oauth_market_read_auth",
					auth_mode: OAUTH_AUTH_MODE,
					authenticated: true,
					client_id: apiEnv.COLLECTOR_MCP_CLIENT_ID?.trim() || "chatgpt-production",
					scopes: [MARKET_READ_SCOPE],
				}),
			);

			const headers = new Headers(apiRequest.headers);
			headers.set("Authorization", `Bearer ${apiEnv.COLLECTOR_MCP_CLIENT_TOKEN}`);
			headers.set("X-QuantPro-OAuth-Authenticated", "1");
			const delegated = new Request(apiRequest, { headers });
			return delegateCollector(delegated, apiEnv, apiCtx, true);
		},
	};

	const defaultHandler: ExportedHandler<OAuthEnv> = {
		async fetch(defaultRequest, defaultEnv) {
			if (new URL(defaultRequest.url).pathname !== OAUTH_AUTHORIZE_PATH) {
				return new Response("Not found", { status: 404 });
			}
			return handleAuthorization(defaultRequest, defaultEnv);
		},
	};

	const provider = new OAuthProvider<OAuthEnv>({
		apiRoute: MCP_PATH,
		apiHandler,
		defaultHandler,
		authorizeEndpoint: OAUTH_AUTHORIZE_PATH,
		tokenEndpoint: OAUTH_TOKEN_PATH,
		clientRegistrationEndpoint: OAUTH_REGISTER_PATH,
		scopesSupported: [MARKET_READ_SCOPE, OFFLINE_ACCESS_SCOPE],
		allowPlainPKCE: false,
		accessTokenTTL: 60 * 60,
		refreshTokenTTL: OAUTH_REFRESH_TTL_SECONDS,
		clientIdMetadataDocumentEnabled: true,
		resourceMetadata: {
			resource,
			authorization_servers: [origin],
			scopes_supported: [MARKET_READ_SCOPE],
			bearer_methods_supported: ["header"],
			resource_name: "QuantPro Collector",
		},
		tokenExchangeCallback: ({ props, requestedScope, clientId }) => ({
			accessTokenProps: {
				...(props && typeof props === "object" ? props : {}),
				principal: env.COLLECTOR_MCP_CLIENT_ID?.trim() || "chatgpt-production",
				oauthClientId: clientId,
				scopes: requestedScope,
			} satisfies OAuthProps,
			accessTokenScope: requestedScope,
		}),
	});
	return { provider, oauthEnv };
}

function isOAuthProtocolPath(pathname: string): boolean {
	return (
		pathname === OAUTH_AUTHORIZE_PATH ||
		pathname === OAUTH_TOKEN_PATH ||
		pathname === OAUTH_REGISTER_PATH ||
		pathname.startsWith("/.well-known/oauth-protected-resource") ||
		pathname.startsWith("/.well-known/oauth-authorization-server")
	);
}

export default {
	async fetch(request: Request, env: CollectorEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Existing internal REST/control-plane endpoints remain owned by the original Worker.
		if (url.pathname !== MCP_PATH && !isOAuthProtocolPath(url.pathname)) {
			return collector.fetch(request, env as never, ctx);
		}

		// Mixed-auth discovery lane: unauthenticated MCP stays available for public/Research tools
		// and for the legacy quote-only fallback. A valid legacy static bearer also remains accepted.
		if (url.pathname === MCP_PATH) {
			const authorization = request.headers.get("Authorization");
			if (!authorization || staticBearerAuthorized(request, env)) {
				return delegateCollector(request, env, ctx, false);
			}
		}

		const oauth = makeOAuthProvider(request, env);
		if (!oauth) {
			// OAuth cannot mint/validate grants without private KV state. Fail closed for OAuth paths.
			if (url.pathname === MCP_PATH) {
				return jsonResponse({ error: "OAUTH_STORE_NOT_CONFIGURED" }, 503);
			}
			return new Response("OAuth store not configured", { status: 503 });
		}
		return oauth.provider.fetch(request, oauth.oauthEnv, ctx);
	},

	async scheduled(controller: ScheduledController, env: CollectorEnv) {
		return collector.scheduled(controller, env as never);
	},
} satisfies ExportedHandler<CollectorEnv>;
