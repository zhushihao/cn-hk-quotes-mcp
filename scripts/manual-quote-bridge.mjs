import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import path from "node:path";
import { registerHooks } from "node:module";

// 与仓内测试同款 resolve 钩子：TS 模块内部的无扩展名相对导入在
// `node --experimental-strip-types` 直跑时也需要补 `.ts`。
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// 非 TS 导入交给默认解析器。
			}
		}
		return nextResolve(specifier, context);
	},
});

// 动态导入：确保钩子在解析模块图之前生效（静态 import 会被提升到钩子注册之前）。
const { assertPublicQuotePrivacy } = await import("../src/quote-projections.ts");

const DEFAULT_SOURCE_URL =
	"https://cn-hk-quotes-mcp.zhushihao710.workers.dev/api/public/quotes";
const DEFAULT_ISSUE_NUMBER = 1;
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "quantpro-collector-manual-quote-bridge/1.0";
const JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)\s*```/i;

/**
 * The workflow and the Worker/Cron path deliberately share the public
 * quote-only contract (issue #7). Manual runs consume the new Worker's
 * `/api/public/quotes` and validate with the same privacy-asserting seam:
 * exact top-level keys, quoted stock fields only, and a hard failure if any
 * holding identity/qty field appears.
 */
export function validateFetchedSnapshot(snapshot) {
	assertPublicQuotePrivacy(snapshot);
	return { total: snapshot.summary.total };
}

export function parsePreviousBridge(body) {
	if (typeof body !== "string" || !body) {
		return { snapshot: null, lastSuccessAt: null };
	}

	const match = body.match(JSON_BLOCK_PATTERN);
	if (!match) {
		return { snapshot: null, lastSuccessAt: null };
	}

	try {
		const payload = JSON.parse(match[1]);
		return {
			snapshot: payload?.snapshot ?? null,
			lastSuccessAt: payload?.bridge?.last_success_at ?? null,
		};
	} catch {
		return { snapshot: null, lastSuccessAt: null };
	}
}

export function createIssueBody(payload) {
	return [
		"# QuantPro Collector A/H 行情计划任务数据桥",
		"",
		"> 机器数据。由 Cloudflare Worker Cron 自动刷新；GitHub Actions 仅用于手工补跑。本载荷为 quote-only（public_quote_snapshot/1），不含任何持仓身份/数量字段；请勿手工编辑 JSON 区域。",
		"",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
	].join("\n");
}

function withHttpStatus(error, status) {
	if (error && typeof error === "object") error.httpStatus = status;
	return error;
}

export async function fetchSnapshot(
	source,
	{ fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 15_000 } = {},
) {
	if (typeof fetchImpl !== "function") throw new Error("global fetch is unavailable");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const separator = source.includes("?") ? "&" : "?";
		const response = await fetchImpl(`${source}${separator}_bridge_ts=${clock()}`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Cache-Control": "no-cache",
				"User-Agent": USER_AGENT,
			},
			signal: controller.signal,
		});
		const raw = await response.text();
		if (!response.ok) {
			throw withHttpStatus(
				new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`),
				response.status,
			);
		}
		try {
			return JSON.parse(raw);
		} catch {
			throw new Error("upstream returned invalid JSON");
		}
	} finally {
		clearTimeout(timer);
	}
}

function repositoryCoordinates(env) {
	const repository = env.GITHUB_REPOSITORY;
	if (typeof repository !== "string" || !repository.includes("/")) {
		throw new Error("GITHUB_REPOSITORY must be owner/repository");
	}
	const separator = repository.indexOf("/");
	const owner = repository.slice(0, separator);
	const repo = repository.slice(separator + 1);
	if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repository");
	return { owner, repo };
}

function githubHeaders(token) {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": USER_AGENT,
		"Content-Type": "application/json",
	};
}

function createGithubClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
	const token = env.GITHUB_TOKEN;
	if (typeof token !== "string" || !token) throw new Error("GITHUB_TOKEN is required");
	if (typeof fetchImpl !== "function") throw new Error("global fetch is unavailable");
	const { owner, repo } = repositoryCoordinates(env);
	const apiBase = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

	async function request(method, issueNumber, body) {
		const response = await fetchImpl(
			`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
			{
				method,
				headers: githubHeaders(token),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
		);
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(
				`GitHub API ${method} failed with HTTP ${response.status}: ${raw.slice(0, 500)}`,
			);
		}
		if (!raw) return {};
		try {
			return JSON.parse(raw);
		} catch {
			throw new Error(`GitHub API ${method} returned invalid JSON`);
		}
	}

	return {
		getIssue: async (issueNumber) => ({ data: await request("GET", issueNumber) }),
		updateIssue: async (issueNumber, update) => request("PATCH", issueNumber, update),
	};
}

function errorText(error) {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function issueNumberFrom(env) {
	const issueNumber = Number(env.ISSUE_NUMBER || DEFAULT_ISSUE_NUMBER);
	if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
		throw new Error("ISSUE_NUMBER must be a positive integer");
	}
	return issueNumber;
}

function sourceList(env, sources) {
	if (Array.isArray(sources)) return sources.filter(Boolean);
	return [env.SOURCE_URL === undefined ? DEFAULT_SOURCE_URL : env.SOURCE_URL].filter(Boolean);
}

export async function runManualQuoteBridge({
	env = process.env,
	github,
	fetchImpl = globalThis.fetch,
	clock = Date.now,
	now = new Date(clock()).toISOString(),
	sources,
} = {}) {
	const githubClient = github ?? createGithubClient({ env, fetchImpl });
	const issueNumber = issueNumberFrom(env);
	const upstreamSources = sourceList(env, sources);
	const current = await githubClient.getIssue(issueNumber);
	const previous = parsePreviousBridge(current?.data?.body ?? "");
	const workflowRunId = String(env.GITHUB_RUN_ID || "manual");
	const workflowRunAttempt = String(env.GITHUB_RUN_ATTEMPT || "1");

	let payload;
	let fetchError = null;
	let usedSource = null;
	let counts = null;

	try {
		let lastError = null;
		for (const [index, source] of upstreamSources.entries()) {
			try {
				const candidate = await fetchSnapshot(source, { fetchImpl, clock });
				counts = validateFetchedSnapshot(candidate);
				payload = {
					schema_version: "1.0",
					bridge: {
						last_attempt_at: now,
						last_attempt_status: "SUCCESS",
						last_success_at: now,
						workflow_run_id: workflowRunId,
						workflow_run_attempt: workflowRunAttempt,
						source,
						error: null,
					},
					snapshot: candidate,
				};
				usedSource = source;
				break;
			} catch (error) {
				lastError = error;
				if (error?.httpStatus === 404 && index < upstreamSources.length - 1) {
					console.info(
						`upstream 404 at ${source}; retrying ${upstreamSources[index + 1]}`,
					);
					continue;
				}
				throw error;
			}
		}
		if (!payload) throw lastError || new Error("all upstream sources failed");
	} catch (error) {
		fetchError = errorText(error);
		payload = {
			schema_version: "1.0",
			bridge: {
				last_attempt_at: now,
				last_attempt_status: "FAIL",
				last_success_at: previous.lastSuccessAt,
				workflow_run_id: workflowRunId,
				workflow_run_attempt: workflowRunAttempt,
				source: usedSource || upstreamSources[0] || "unknown",
				error: fetchError,
			},
			snapshot: previous.snapshot,
		};
	}

	const body = createIssueBody(payload);
	await githubClient.updateIssue(issueNumber, { body });

	console.info(`bridge_status=${payload.bridge.last_attempt_status}`);
	console.info(`portfolio_version=${payload.snapshot?.portfolio_version ?? "null"}`);
	console.info(`snapshot_time=${payload.snapshot?.snapshot_time ?? "null"}`);
	console.info(`system_quality=${payload.snapshot?.system_quality ?? "null"}`);
	console.info(`total=${payload.snapshot?.summary?.total ?? "null"}`);
	if (fetchError) console.error(fetchError);

	return { payload, body, fetchError, counts, usedSource };
}

async function main() {
	try {
		const result = await runManualQuoteBridge();
		if (result.fetchError) process.exitCode = 1;
	} catch (error) {
		console.error(errorText(error));
		process.exitCode = 1;
	}
}

const currentFile = resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedFile && invokedFile === currentFile) await main();
