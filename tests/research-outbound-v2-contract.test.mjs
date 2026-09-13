import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v2",
);
const outbound = await import("../src/research-outbound-v2.ts");

async function fixture(name) {
	return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
}

test("C4 fixture directory exactly matches Research 55f2493 manifest", async () => {
	const names = (await readdir(fixtureDir)).sort();
	const manifest = await readFile(path.join(fixtureDir, "MANIFEST.sha256"), "utf8");
	const listed = new Map(
		manifest
			.trim()
			.split("\n")
			.map((line) => {
				const [digest, name] = line.split("  ");
				return [name, digest];
			}),
	);
	assert.deepEqual(names, ["MANIFEST.sha256", ...[...listed.keys()].sort()]);
	for (const [name, digest] of listed) {
		const bytes = await readFile(path.join(fixtureDir, name));
		assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, name);
	}
});

test("C4 accepts every frozen outbound-v2 metadata and object envelope", async () => {
	for (const name of [
		"metadata_source.public.json",
		"metadata_source.private.json",
		"metadata_document_version.public.json",
		"metadata_document_version.private.json",
		"metadata_evidence.json",
		"metadata_coverage.json",
		"metadata_accumulator.json",
		"metadata_job.queued.json",
		"object_small.json",
		"object_chunked.json",
	]) {
		for (const record of await fixture(name)) {
			assert.deepEqual(await outbound.verifyOutboundV2Record(record), record, name);
		}
	}
});

test("C4 preserves PUBLIC/PRIVATE, rejects INTERNAL, and does not accept hidden local fields", async () => {
	const publicSource = (await fixture("metadata_source.public.json"))[0];
	const privateSource = (await fixture("metadata_source.private.json"))[0];
	const hiddenKeys = await fixture("negative_hidden_keys.json");
	assert.equal(outbound.validateOutboundV2Record(publicSource).visibility, "PUBLIC");
	assert.equal(outbound.validateOutboundV2Record(privateSource).visibility, "PRIVATE");
	assert.throws(
		() => outbound.assertResearchVisibility("INTERNAL"),
		(error) => error?.error_code === "FILTERED",
	);
	assert.throws(
		() => outbound.assertOutboundV2PayloadSafe(hiddenKeys.input),
		(error) =>
			error?.error_code === "INTEGRITY_FAILED" &&
			!/planted|D:\\|\/home\//i.test(error.safe_message),
	);
});

test("C4 verifies replay, payload corruption, chunk corruption, and the frozen safe-error model", async () => {
	const replay = await fixture("replay_duplicate.json");
	assert.deepEqual(replay.records[0], replay.records[1]);
	assert.deepEqual(await outbound.verifyOutboundV2Record(replay.records[0]), replay.records[0]);

	const tamperedPayload = await fixture("corruption_tampered_payload.json");
	await assert.rejects(
		() => outbound.verifyOutboundV2Record(tamperedPayload.record),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);

	const tamperedChunk = await fixture("corruption_tampered_chunk.json");
	await assert.rejects(
		() =>
			outbound.verifyOutboundV2ObjectChunks(
				tamperedChunk.record,
				tamperedChunk.chunks_hex.map((chunk) => Buffer.from(chunk, "hex")),
			),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);

	for (const sample of (await fixture("error_model_samples.json")).samples) {
		assert.deepEqual(outbound.validateResearchError(sample), sample);
	}
});
