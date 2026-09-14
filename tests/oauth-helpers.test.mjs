import assert from "node:assert/strict";
import test from "node:test";
import {
	MARKET_READ_SCOPE,
	constantTimeEqual,
	cookieValue,
	decorateToolSecuritySchemes,
	escapeHtml,
	securitySchemesForTool,
} from "../src/oauth-helpers.ts";

test("market-read tools advertise OAuth while public tools stay anonymous", () => {
	assert.deepEqual(securitySchemesForTool("get_portfolio_quotes"), [
		{ type: "oauth2", scopes: [MARKET_READ_SCOPE] },
	]);
	assert.deepEqual(securitySchemesForTool("get_control_plane_status"), [
		{ type: "oauth2", scopes: [MARKET_READ_SCOPE] },
	]);
	assert.deepEqual(securitySchemesForTool("get_public_quotes"), [{ type: "noauth" }]);
	assert.deepEqual(securitySchemesForTool("get_coverage_status"), [{ type: "noauth" }]);
});

test("tools/list decoration writes root and back-compat _meta schemes", () => {
	const payload = {
		jsonrpc: "2.0",
		id: 1,
		result: {
			tools: [
				{ name: "get_portfolio_quotes", inputSchema: {}, _meta: { keep: true } },
				{ name: "get_public_quotes", inputSchema: {} },
			],
		},
	};
	decorateToolSecuritySchemes(payload);
	const [live, publicTool] = payload.result.tools;
	assert.deepEqual(live.securitySchemes, [{ type: "oauth2", scopes: [MARKET_READ_SCOPE] }]);
	assert.deepEqual(live._meta.securitySchemes, live.securitySchemes);
	assert.equal(live._meta.keep, true);
	assert.deepEqual(publicTool.securitySchemes, [{ type: "noauth" }]);
	assert.deepEqual(publicTool._meta.securitySchemes, publicTool.securitySchemes);
});

test("constant-time comparator preserves exact credential semantics", () => {
	assert.equal(constantTimeEqual("abc", "abc"), true);
	assert.equal(constantTimeEqual("abc", "abd"), false);
	assert.equal(constantTimeEqual("abc", "abc "), false);
	assert.equal(constantTimeEqual("", ""), true);
});

test("HTML escaping and cookie parsing do not leak markup", () => {
	assert.equal(
		escapeHtml('<a href="x">&\'y</a>'),
		"&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&lt;/a&gt;",
	);
	assert.equal(cookieValue("a=1; qp_oauth_csrf=deadbeef; b=2", "qp_oauth_csrf"), "deadbeef");
	assert.equal(cookieValue(null, "qp_oauth_csrf"), null);
});
