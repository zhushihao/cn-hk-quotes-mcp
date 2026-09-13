import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const fixtureDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v2",
);
const replica = await import("../src/research-replica.ts");
const outbound = await import("../src/research-outbound-v2.ts");
const worker = (await import("../src/index.ts")).default;

async function fixture(name) {
	return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
}

class FakeD1 {
	messages = new Set();
	batches = [];
	health = {
		last_attempt_at: null,
		last_success_at: null,
		last_message_id: null,
		last_error_code: null,
		accepted_messages: 0,
	};

	prepare(sql) {
		const db = this;
		return {
			params: [],
			bind(...params) {
				this.params = params;
				return this;
			},
			async run() {
				if (sql.includes("accepted_messages")) {
					db.health.last_attempt_at = this.params[0];
					db.health.last_success_at = this.params[1];
					db.health.last_message_id = this.params[2];
					db.health.accepted_messages += this.params[3];
				}
				return { meta: { changes: 1 } };
			},
			async first() {
				return db.health;
			},
		};
	}

	async batch(statements) {
		this.batches.push(statements);
		const messageId = statements[0].params[0];
		const inserted = !this.messages.has(messageId);
		if (inserted) this.messages.add(messageId);
		return statements.map((_, index) => ({
			meta: { changes: index === 0 && inserted ? 1 : 0 },
		}));
	}
}

class FakeR2 {
	objects = new Map();

	async put(key, body, options) {
		this.objects.set(key, { body, options });
	}
}

function storage() {
	return { db: new FakeD1(), objects: new FakeR2() };
}

test("C5 stores path-free metadata, document links, and an immutable recovery journal", async () => {
	const store = storage();
	const document = (await fixture("metadata_document_version.public.json"))[0];
	const result = await replica.ingestResearchReplicaRecord(
		store,
		document,
		null,
		"2026-09-13T14:00:00Z",
	);
	assert.equal(result.status, "APPLIED");
	assert.equal(result.record_type, "document_version");
	assert.equal(store.db.batches.length, 1);
	assert.equal(
		store.db.batches[0].length,
		4,
		"message + current record + body + attachment links",
	);
	assert.equal(store.objects.objects.size, 1, "only the journal is written for metadata");
	assert.ok(
		[...store.objects.objects.keys()][0].startsWith("research-replica-journal/v2/outbound_"),
	);
});

test("C5 validates object bytes before private R2 storage and replays without a new logical message", async () => {
	const store = storage();
	const bytes = new TextEncoder().encode("synthetic raw document for C5 object test");
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	const digest = [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const object = structuredClone((await fixture("object_small.json"))[0]);
	object.payload.byte_size = bytes.byteLength;
	object.payload.chunking = {
		chunked: false,
		chunk_size: bytes.byteLength,
		total_chunks: 1,
		chunk_sha256: [digest],
	};
	object.payload.content_sha256 = digest;
	object.payload.object_id = digest;
	object.payload.manifest_message_id = "pending";
	object.message_id = await outbound.computeOutboundV2MessageId(object);
	object.payload.manifest_message_id = object.message_id;

	const first = await replica.ingestResearchReplicaRecord(
		store,
		object,
		[bytes],
		"2026-09-13T14:01:00Z",
	);
	const replay = await replica.ingestResearchReplicaRecord(
		store,
		object,
		[bytes],
		"2026-09-13T14:02:00Z",
	);
	assert.equal(first.status, "APPLIED");
	assert.equal(replay.status, "REPLAY");
	assert.equal(store.db.messages.size, 1);
	assert.equal(store.objects.objects.size, 2, "journal plus content-addressed raw object");
	assert.equal(store.db.health.accepted_messages, 1);
});

test("C5 fails closed before storage on corrupted body or forbidden metadata", async () => {
	const store = storage();
	const corruption = await fixture("corruption_tampered_chunk.json");
	await assert.rejects(
		() =>
			replica.ingestResearchReplicaRecord(
				store,
				corruption.record,
				corruption.chunks_hex.map((chunk) => Buffer.from(chunk, "hex")),
			),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
	assert.equal(store.db.batches.length, 0);
	assert.equal(store.objects.objects.size, 0);

	const source = structuredClone((await fixture("metadata_source.public.json"))[0]);
	source.payload.local_path = "D:\\Research\\secret.db";
	await assert.rejects(
		() => replica.ingestResearchReplicaRecord(store, source),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

test("C5 exposes health for observation and makes its recovery path the same idempotent ingest", async () => {
	const store = storage();
	const source = (await fixture("metadata_source.private.json"))[0];
	await replica.ingestResearchReplicaRecord(store, source, null, "2026-09-13T14:03:00Z");
	assert.deepEqual(await replica.readResearchReplicaHealth(store), {
		last_attempt_at: "2026-09-13T14:03:00Z",
		last_success_at: "2026-09-13T14:03:00Z",
		last_message_id: source.message_id,
		last_error_code: null,
		accepted_messages: 1,
	});
	assert.equal((await replica.ingestResearchReplicaRecord(store, source)).status, "REPLAY");
});

test("C5 internal transport is separate from MCP and fails closed without its own scope and storage", async () => {
	const response = await worker.fetch(
		new Request("https://worker.example/internal/research-replica/v2/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ record: (await fixture("metadata_source.public.json"))[0] }),
		}),
		{},
		{},
	);
	assert.equal(response.status, 503);
	assert.deepEqual(Object.keys(await response.json()).sort(), [
		"error_code",
		"request_id",
		"retryable",
		"safe_message",
	]);
});
