export const MARKET_READ_SCOPE = "market:read" as const;
export const OFFLINE_ACCESS_SCOPE = "offline_access" as const;

export type ToolSecurityScheme =
	| { type: "noauth" }
	| { type: "oauth2"; scopes: string[] };

const MARKET_READ_TOOLS = new Set(["get_portfolio_quotes", "get_control_plane_status"]);

export function securitySchemesForTool(name: string): ToolSecurityScheme[] {
	return MARKET_READ_TOOLS.has(name)
		? [{ type: "oauth2", scopes: [MARKET_READ_SCOPE] }]
		: [{ type: "noauth" }];
}

export function decorateToolSecuritySchemes(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const root = payload as Record<string, unknown>;
	const result = root.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) return payload;
	const tools = (result as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) return payload;

	for (const candidate of tools) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const tool = candidate as Record<string, unknown>;
		if (typeof tool.name !== "string") continue;
		const schemes = securitySchemesForTool(tool.name);
		tool.securitySchemes = schemes;
		const meta =
			tool._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta)
				? { ...(tool._meta as Record<string, unknown>) }
				: {};
		meta.securitySchemes = schemes;
		tool._meta = meta;
	}
	return payload;
}

export function constantTimeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	const max = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < max; i += 1) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function cookieValue(cookieHeader: string | null, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const [rawName, ...rest] = part.trim().split("=");
		if (rawName === name) return rest.join("=");
	}
	return null;
}

export function randomHex(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
