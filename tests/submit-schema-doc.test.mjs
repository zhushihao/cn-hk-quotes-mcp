import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Issue #19-followup: the submit tool's advertised contract must keep
// describing the exact proposal schema the server-side validator enforces.
// A client that follows this description can never hit a silent
// VALIDATION_FAILED on key-shape grounds; if the validator changes, this
// lock forces the description to change with it.
test("submit tool description advertises the exact proposal schema contract", async () => {
	const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	const start = index.indexOf('"submit_research_result_proposal"');
	const end = index.indexOf('"defer_research_job"', start);
	assert.ok(start > 0 && end > start, "submit tool registration must exist");
	const section = index.slice(start, end);
	for (const fragment of [
		"exact-keys",
		"job_id",
		"summary",
		"findings",
		"recommendation_hint",
		"sources_consulted",
		"completed_at",
		"tokens_used",
		"THESIS_REVIEW",
		"INSUFFICIENT_DATA",
		"counter_evidence",
		"≤64KiB",
	]) {
		assert.ok(section.includes(fragment), `description must mention ${fragment}`);
	}
});
