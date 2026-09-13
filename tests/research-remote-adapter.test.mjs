import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const remote = await import("../src/research-remote-adapter.ts");

class FakeD1 {
	constructor(records) {
		this.records = records;
	}

	prepare(sql) {
		const db = this;
		return {
			params: [],
			bind(...params) {
				this.params = params;
				return this;
			},
			async all() {
				const [recordType, visibility] = this.params;
				return {
					results: db.records.filter(
						(row) => row.record_type === recordType && row.visibility === visibility,
					),
				};
			},
			async first() {
				const [visibility, key] = this.params;
				return (
					db.records.find(
						(row) =>
							row.record_type === "document_version" &&
							row.visibility === visibility &&
							JSON.parse(row.payload_json).document.document_id === key,
					) ?? null
				);
			},
		};
	}
}

class FakeR2 {
	constructor(objects) {
		this.objects = objects;
	}

	async get(key) {
		const bytes = this.objects.get(key);
		return bytes
			? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
			: null;
	}
}

function documentRow({ visibility = "PUBLIC", documentId = "doc-public", content }) {
	const hash = createHash("sha256").update(content).digest("hex");
	return {
		record_type: "document_version",
		record_key: `version-${documentId}`,
		message_id: `outbound_${"a".repeat(40)}`,
		visibility,
		payload_json: JSON.stringify({
			document: { document_id: documentId, visibility, title: "Synthetic remote document" },
			version: { content_sha256: hash, media_type: "text/plain", byte_size: content.byteLength },
			attachments: [],
		}),
		generated_at: "2026-09-13T00:00:00Z",
		updated_at: "2026-09-13T00:00:00Z",
	};
}

test("C6 remote adapter reads verified Collector-owned object bytes without a local adapter", async () => {
	const body = new TextEncoder().encode("real replica body, synthetic test source");
	const row = documentRow({ content: body });
	const contentSha = JSON.parse(row.payload_json).version.content_sha256;
	const storage = {
		db: new FakeD1([row]),
		objects: new FakeR2(new Map([[`research-objects/sha256/${contentSha}`, body]])),
	};
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const document = await adapter.getDocument("doc-public");
	assert.equal(document.document.document_id, "doc-public");
	assert.equal(document.body_text, "real replica body, synthetic test source");
	assert.equal(document.source, "COLLECTOR_REPLICA");
});

test("C6 remote adapter is visibility fail-closed and emits only the common safe error model", async () => {
	const privateBody = new TextEncoder().encode("private body");
	const row = documentRow({ visibility: "PRIVATE", documentId: "doc-private", content: privateBody });
	const contentSha = JSON.parse(row.payload_json).version.content_sha256;
	const storage = {
		db: new FakeD1([row]),
		objects: new FakeR2(new Map([[`research-objects/sha256/${contentSha}`, privateBody]])),
	};
	const publicAdapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	await assert.rejects(
		() => publicAdapter.getDocument("doc-private"),
		(error) =>
			error?.error_code === "NOT_FOUND" &&
			Object.keys(error.asError()).sort().join(",") ===
				"error_code,request_id,retryable,safe_message",
	);
});
