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
const fixtureV3Dir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v3",
);
const outbound = await import("../src/research-outbound-v2.ts");

async function fixture(name) {
	return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
}

async function fixtureV3(name) {
	return JSON.parse(await readFile(path.join(fixtureV3Dir, name), "utf8"));
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

test("C4 accepts every frozen outbound-v3 envelope without changing v2", async () => {
	const names = [
		"metadata_source.public.json", "metadata_source.private.json",
		"metadata_document_version.public.json", "metadata_document_version.private.json",
		"metadata_evidence.json", "metadata_coverage.json", "metadata_accumulator.json",
		"metadata_job.queued.json", "metadata_job.queued.trigger_evidence.json",
		"metadata_source_health.json", "object_small.json", "object_chunked.json",
	];
	for (const name of names) {
		for (const record of await fixtureV3(name)) {
			assert.equal(record.schema_version, outbound.OUTBOUND_V3_SCHEMA_VERSION);
			assert.deepEqual(await outbound.verifyOutboundV2Record(record), record, name);
		}
	}
	const manifest = await readFile(path.join(fixtureV3Dir, "MANIFEST.sha256"), "utf8");
	for (const line of manifest.trim().split("\n")) {
		const [digest, name] = line.split("  ");
		assert.equal(createHash("sha256").update(await readFile(path.join(fixtureV3Dir, name))).digest("hex"), digest, name);
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

test("C9 accepts v4 Evidence only with its complete immutable source reference and preserves v2/v3 exactness", async () => {
	const legacy = structuredClone((await fixture("metadata_evidence.json"))[0]);
	const document = (await fixture("metadata_document_version.public.json"))[0];
	const v4 = structuredClone(legacy);
	v4.schema_version = outbound.OUTBOUND_V4_SCHEMA_VERSION;
	v4.payload.source_reference = {
		document_id: document.payload.document.document_id,
		document_version_id: document.payload.version.version_id,
		attachment_id: null,
		content_sha256: "a".repeat(64),
		byte_start: 0,
		byte_end: 1,
		span_sha256: "b".repeat(64),
	};
	v4.payload.event_time = null;
	v4.payload.published_at = "2026-09-13T00:00:00Z";
	v4.payload.first_seen_at = "2026-09-13T00:01:00Z";
	v4.payload.ingested_at = "2026-09-13T00:02:00Z";
	v4.message_id = await outbound.computeOutboundV2MessageId(v4);
	assert.deepEqual(await outbound.verifyOutboundV2Record(v4), v4);

	const incomplete = structuredClone(v4);
	delete incomplete.payload.source_reference.span_sha256;
	await assert.rejects(() => outbound.verifyOutboundV2Record(incomplete), (error) =>
		error?.error_code === "INTEGRITY_FAILED",
	);
	const contaminatedLegacy = structuredClone(legacy);
	contaminatedLegacy.schema_version = outbound.OUTBOUND_V3_SCHEMA_VERSION;
	contaminatedLegacy.payload.source_reference = structuredClone(v4.payload.source_reference);
	contaminatedLegacy.message_id = await outbound.computeOutboundV2MessageId(contaminatedLegacy);
	await assert.rejects(() => outbound.verifyOutboundV2Record(contaminatedLegacy), (error) =>
		error?.error_code === "INTEGRITY_FAILED",
	);
});
