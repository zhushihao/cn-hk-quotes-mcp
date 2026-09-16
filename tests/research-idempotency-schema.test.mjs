import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && !path.extname(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Let the default resolver report the original error for non-TS imports.
			}
		}
		return nextResolve(specifier, context);
	},
});

const { createServer } = await import("../src/index.ts");
const { RESEARCH_IDEMPOTENCY_KEY_PATTERN } = await import("../src/research-workflow.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { RESEARCH_SUBMIT_SCOPE } = await import("../src/research-scopes.ts");

const TOOL_NAMES = ["submit_research_result_proposal", "defer_research_job"];
const VALID_KEY = "chatgpt_submit:job_abc:g2";
const ISO_KEY = "2026-09-16T05:58:00.123+00:00";

function argumentsFor(toolName, idempotencyKey) {
	if (toolName === "submit_research_result_proposal") {
		return {
			job_id: "job_abc",
			expected_generation: 1,
			idempotency_key: idempotencyKey,
			proposal: {},
		};
	}
	return {
		job_id: "job_abc",
		expected_generation: 1,
		idempotency_key: idempotencyKey,
		reason: "RECHECK_REQUIRED",
		recheck_at: "2099-01-01T00:00:00.000Z",
	};
}

async function connectedClient(
	env,
	scopes,
	principal = "stable-research-principal",
	issuer = "https://issuer.example",
) {
	const server = createServer(env, "SKIPPED_UNAUTHORIZED", scopes, principal, issuer);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "research-idempotency-schema-test", version: "0.0.0" });
	await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

test("submit/defer publish one shared idempotency schema contract through MCP", async () => {
	const { client, server } = await connectedClient(undefined, new Set());
	try {
		const listed = await client.listTools();
		const tools = Object.fromEntries(
			listed.tools
				.filter((tool) => TOOL_NAMES.includes(tool.name))
				.map((tool) => [tool.name, tool]),
		);
		assert.deepEqual(Object.keys(tools).sort(), [...TOOL_NAMES].sort());

		const keySchemas = TOOL_NAMES.map(
			(name) => tools[name].inputSchema.properties.idempotency_key,
		);
		assert.deepEqual(keySchemas[0], keySchemas[1]);
		assert.deepEqual(keySchemas[0], {
			type: "string",
			pattern: RESEARCH_IDEMPOTENCY_KEY_PATTERN.source,
			minLength: 8,
			maxLength: 128,
		});

		const commonDescription = "8–128 个字符，仅允许 ASCII A-Z/a-z/0-9/:/_/-";
		assert.match(
			tools.submit_research_result_proposal.description,
			new RegExp(commonDescription),
		);
		assert.match(tools.defer_research_job.description, new RegExp(commonDescription));
		assert.match(
			tools.submit_research_result_proposal.description,
			/chatgpt_submit:<job_id>:g<lease_generation>/,
		);
		assert.match(
			tools.defer_research_job.description,
			/chatgpt_defer:<job_id>:g<lease_generation>/,
		);
		for (const tool of Object.values(tools)) {
			assert.equal(JSON.stringify(tool.inputSchema).includes("claim_token"), false);
			assert.equal(tool.inputSchema.properties.idempotency_key.type, "string");
		}
	} finally {
		await server.close();
	}
});

test("MCP schema accepts the valid key and rejects bad keys before handler/domain", async () => {
	let workflowAccesses = 0;
	const env = {
		get RESEARCH_REPLICA() {
			workflowAccesses += 1;
			throw new Error("research workflow sentinel reached");
		},
		RESEARCH_OBJECTS: {},
	};
	const { client, server } = await connectedClient(env, new Set([RESEARCH_SUBMIT_SCOPE]));
	try {
		const baselineAccesses = workflowAccesses;
		for (const toolName of TOOL_NAMES) {
			const validResult = await client.callTool({
				name: toolName,
				arguments: argumentsFor(toolName, VALID_KEY),
			});
			assert.equal(validResult.isError, true);
			assert.match(validResult.content?.[0]?.text ?? "", /STORE_UNAVAILABLE/);
		}
		assert.ok(
			workflowAccesses > baselineAccesses,
			"valid keys must reach the handler/domain boundary",
		);

		const accessesAfterValidKeys = workflowAccesses;
		for (const invalidKey of ["a".repeat(7), "a".repeat(129), ISO_KEY]) {
			for (const toolName of TOOL_NAMES) {
				const invalidResult = await client.callTool({
					name: toolName,
					arguments: argumentsFor(toolName, invalidKey),
				});
				assert.equal(invalidResult.isError, true);
				assert.match(
					invalidResult.content?.[0]?.text ?? "",
					/Input validation error/,
					`${toolName} must reject ${invalidKey} at the MCP schema layer`,
				);
			}
		}
		assert.equal(
			workflowAccesses,
			accessesAfterValidKeys,
			"schema-rejected keys must not enter the handler/domain",
		);
	} finally {
		await server.close();
	}
});
