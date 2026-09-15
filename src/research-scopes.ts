/**
 * Research write-plane scope gate (2026-09-15 research-backend design §A4).
 *
 * Two new scopes (`research:claim` / `research:submit`) gate exactly one
 * write tool each. There is deliberately no `research:read`: the read plane
 * is hard-clamped to PUBLIC at adapter construction, and `research:read` is
 * reserved for the future PRIVATE read plane (post-#16). No scope implies
 * any other scope; `market:read` never grants research access.
 *
 * Resolution rules (the server-side `COLLECTOR_MCP_CLIENT_SCOPES`
 * configuration is an uncircumventable ceiling):
 *   - The request Authorization header must equal `Bearer <configured token>`
 *     byte-for-byte (same discipline as `resolveLiveOverlayStatus`); anything
 *     else yields the empty set (fail-closed, including unconfigured token).
 *   - With a forwarded scope header (set only by the OAuth bridge in
 *     `oauth-entry.ts` after stripping any client-supplied copy): effective
 *     scopes = forwarded set ∩ configured set. Forged headers cannot exceed
 *     the ceiling.
 *   - Without the header (static-credential path): effective scopes =
 *     configured set.
 *
 * This module is pure: no IO, no logging, no token values echoed anywhere.
 */

/** Gate for `claim_research_job`. */
export const RESEARCH_CLAIM_SCOPE = "research:claim";

/** Gate for `submit_research_result_proposal`. */
export const RESEARCH_SUBMIT_SCOPE = "research:submit";

/**
 * Forwarded scope header. Only trusted when set by `handleMcp` after it has
 * replaced the Authorization header; the bridge deletes any client-supplied
 * copy before setting its own value.
 */
export const FORWARDED_SCOPES_HEADER = "X-QuantPro-Client-Scopes";
/** Authenticated OAuth client identity, stamped only by the OAuth bridge. */
export const FORWARDED_CLIENT_ID_HEADER = "X-QuantPro-Client-Id";

/** Parse a space/comma separated scope list into a set (order-insensitive). */
function parseScopeList(value: string | null | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean),
	);
}

export function resolveResearchScopes(
	authorizationHeader: string | null | undefined,
	forwardedScopesHeader: string | null | undefined,
	configuredToken: string | null | undefined,
	configuredScopes: string | null | undefined,
): Set<string> {
	// Byte-exact credential match is the precondition for any scope at all.
	if (!configuredToken || authorizationHeader !== `Bearer ${configuredToken}`) {
		return new Set();
	}
	const configured = parseScopeList(configuredScopes);
	if (forwardedScopesHeader === null || forwardedScopesHeader === undefined) {
		// Static-credential direct path: the configured set is the grant.
		return configured;
	}
	// Forwarded path: intersection only. A static credential holder forging
	// this header still cannot exceed its own configured ceiling.
	const forwarded = parseScopeList(forwardedScopesHeader);
	const effective = new Set<string>();
	for (const scope of forwarded) {
		if (configured.has(scope)) effective.add(scope);
	}
	return effective;
}

/** A client identity is trusted only on the authenticated bridge path. */
export function resolveResearchClientId(
	authorizationHeader: string | null | undefined,
	forwardedClientId: string | null | undefined,
	configuredToken: string | null | undefined,
): string | null {
	if (!configuredToken || authorizationHeader !== `Bearer ${configuredToken}`) return null;
	if (typeof forwardedClientId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(forwardedClientId)) return null;
	return forwardedClientId;
}

/** All three grants are required: client allowlist, scope, and job namespace. */
export function permitsFormalResearchOperation(input: {
	clientId: string | null;
	scopes: ReadonlySet<string>;
	requiredScope: string;
	configuredClientIds: string | null | undefined;
	configuredNamespaces: string | null | undefined;
	jobId: string;
}): boolean {
	if (!input.clientId || !input.scopes.has(input.requiredScope)) return false;
	// These identities belong to engineering, RESEARCH transport, or receipt
	// consumption roles.  Configuration cannot accidentally promote any of
	// them into a formal ChatGPT result owner merely by adding a scope.
	if (new Set(["codex", "engineering", "producer", "receipt-reader", "receipt_reader"]).has(input.clientId.toLowerCase())) {
		return false;
	}
	const clients = parseScopeList(input.configuredClientIds);
	const namespaces = parseScopeList(input.configuredNamespaces);
	if (!clients.has(input.clientId) || namespaces.size === 0) return false;
	return [...namespaces].some((namespace) => input.jobId.startsWith(`${namespace}:`));
}
