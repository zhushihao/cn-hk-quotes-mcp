import assert from "node:assert/strict";
import test from "node:test";

const { AUTOMATION_CONTROL_BUNDLES, AUTOMATION_REGISTRY_KEYS } = await import(
	"../src/automation-control-bundle.generated.ts"
);

test("production automation runtime bundle contains every registry key and exact prompt contract", () => {
	assert.equal(AUTOMATION_REGISTRY_KEYS.length, 6);
	assert.deepEqual(Object.keys(AUTOMATION_CONTROL_BUNDLES), [...AUTOMATION_REGISTRY_KEYS]);
	for (const key of AUTOMATION_REGISTRY_KEYS) {
		const bundle = AUTOMATION_CONTROL_BUNDLES[key];
		assert.equal(bundle.schema_version, "quantpro-automation-bundle-v1");
		assert.equal(bundle.status, "PRODUCTION");
		assert.equal(bundle.registry_key, key);
		assert.match(bundle.production_ref, /^[0-9a-f]{40}$/);
		const head = bundle.prompt.split("\n").slice(0, 10).join("\n");
		assert.ok(head.includes(`PROMPT_ID=${bundle.prompt_id}`));
		assert.ok(head.includes("STATUS=PRODUCTION"));
		assert.ok(head.includes(`WRITE_SCOPE=${bundle.write_scope}`));
		for (const item of [...bundle.automation_guidance, ...bundle.research_guidance]) {
			assert.ok(item.path.length > 0);
			assert.ok(item.content.trim().length > 0);
		}
	}
});
