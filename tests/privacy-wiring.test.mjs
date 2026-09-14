import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Issue #7 隐私收口的源码级不变式（wiring 断言，与 live-overlay.test.mjs 同风格）。
 * 只做静态断言，不引入真实 token/持仓数据。
 */
test("Issue #1 bridge payload is always projected quote-only (success and failure paths)", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const bridgeBody = source.slice(
		source.indexOf("export async function updateQuoteBridge"),
		source.indexOf("function createServer"),
	);

	// 成功路径：写公开 Issue 的载荷必须投影。
	assert.match(bridgeBody, /snapshot: toPublicQuoteSnapshot\(upstream\.snapshot\),/);
	// 失败路径：历史快照回退同样投影，防止身份字段回流公开面。
	assert.match(
		bridgeBody,
		/snapshot: previous\.snapshot \? toPublicQuoteSnapshot\(previous\.snapshot\) : null,/,
	);
});

test("anonymous get_portfolio_quotes is projected quote-only; authorized keeps full LIVE", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const toolStart = source.indexOf('"get_portfolio_quotes"');
	const toolBody = source.slice(toolStart, source.indexOf("get_public_quotes"));

	assert.match(
		toolBody,
		/const displaySnapshot = isLiveOverlayEnabled\(liveOverlayStatus\)[\s\S]*?upstream\.snapshot[\s\S]*?toPublicQuoteSnapshot\(upstream\.snapshot\);/,
	);
	assert.match(toolBody, /\{ \.\.\.displaySnapshot, control_plane_status: controlPlaneStatus \}/);
});

test("upstream fetch carries CF Access service-token headers when bindings are set", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /accessHeaders\["CF-Access-Client-Id"\]/);
	assert.match(source, /accessHeaders\["CF-Access-Client-Secret"\]/);
	assert.match(source, /\.\.\.accessHeaders,/);
	// 绑定未配置时不得硬卡（Access 开启前保持匿名兼容）。
	assert.match(source, /env\?\.CF_ACCESS_CLIENT_ID && env\?\.CF_ACCESS_CLIENT_SECRET/);
});

test("private LIVE surface is preserved alongside the public one (dual contract)", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	// 私域 gated 端点仍在且鉴权门不变。
	assert.match(source, /if \(url\.pathname === "\/api\/portfolio-quotes"\)/);
	assert.match(source, /function isUniverseAuthorized/);
	// 公开路由无鉴权（它是明确公开面），但必须投影 quote-only。
	assert.match(source, /if \(url\.pathname === "\/api\/public\/quotes"\)/);
	assert.match(source, /return jsonResponse\(await fetchPublicQuoteSnapshot\(context, env\)\);/);
	// 私域响应保持富投影：gated 端点直接返回 upstream.snapshot（未投影）。
	const gatedBody = source.slice(
		source.indexOf("async function handleDynamicPortfolioQuotes"),
		source.indexOf("async function handlePublicQuotes"),
	);
	assert.match(gatedBody, /return jsonResponse\(upstream\.snapshot\);/);
	assert.doesNotMatch(gatedBody, /toPublicQuoteSnapshot/);
});

test("Issue #8 auth split cannot make the internal universe token an MCP credential", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const internalGate = source.slice(
		source.indexOf("function requestInternalUniverseStatus"),
		source.indexOf("function requestMcpMarketReadStatus"),
	);
	const mcpGate = source.slice(
		source.indexOf("function requestMcpMarketReadStatus"),
		source.indexOf("function isUniverseAuthorized"),
	);
	assert.match(internalGate, /PORTFOLIO_UNIVERSE_TOKEN/);
	assert.doesNotMatch(internalGate, /COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(mcpGate, /COLLECTOR_MCP_CLIENT_TOKEN/);
	assert.match(mcpGate, /COLLECTOR_MCP_CLIENT_SCOPES/);
	assert.match(mcpGate, /COLLECTOR_MCP_CLIENT_ID/);
	const auditHelper = source.slice(
		source.indexOf("function marketReadAuditFields"),
		source.indexOf("/** KV 中的 LIVE 面"),
	);
	assert.match(auditHelper, /MARKET_READ_AUTH_MODE/);
	assert.doesNotMatch(auditHelper, /COLLECTOR_MCP_CLIENT_TOKEN|PORTFOLIO_UNIVERSE_TOKEN/);
	assert.doesNotMatch(mcpGate, /PORTFOLIO_UNIVERSE_TOKEN/);
});
