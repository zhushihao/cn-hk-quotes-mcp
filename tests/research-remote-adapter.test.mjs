import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const remote = await import("../src/research-remote-adapter.ts");

const encoder = new TextEncoder();

function sha256HexOf(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * FakeD1 dispatches on the SQL text shape, mirroring the two query families
 * the read adapter issues:
 *  - list queries ("record_type=? AND visibility=? ... LIMIT ?") -> .all()
 *  - document queries ("json_extract(payload_json, ...)") -> .all() multi-row
 *  - key queries ("record_key=?") -> .first()
 */
class FakeD1 {
	constructor(records) {
		this.records = records;
	}

	documentRows(visibility, documentId) {
		return this.records.filter(
			(row) =>
				row.record_type === "document_version" &&
				row.visibility === visibility &&
				JSON.parse(row.payload_json).document.document_id === documentId,
		);
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
				if (sql.includes("json_extract")) {
					const [visibility, documentId] = this.params;
					return { results: db.documentRows(visibility, documentId) };
				}
				const [recordType, visibility, limit] = this.params;
				const rows = db.records.filter(
					(row) => row.record_type === recordType && row.visibility === visibility,
				);
				return { results: typeof limit === "number" ? rows.slice(0, limit) : rows };
			},
			async first() {
				if (sql.includes("json_extract")) {
					const [visibility, documentId] = this.params;
					return db.documentRows(visibility, documentId)[0] ?? null;
				}
				if (sql.includes("record_key=?")) {
					const [recordType, recordKey, visibility] = this.params;
					return (
						db.records.find(
							(row) =>
								row.record_type === recordType &&
								row.record_key === recordKey &&
								row.visibility === visibility,
						) ?? null
					);
				}
				return null;
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

/**
 * Build one synthetic document_version replica row plus the R2 objects its
 * references resolve to.  All data is code-inline synthetic; the frozen
 * fixtures directory is never touched.
 */
function documentVersionRow({
	documentId = "doc-1",
	versionId = "ver-1",
	versionNumber = 1,
	revisionKind = "ORIGINAL",
	storedReadable = false,
	ownMediaType = "application/pdf",
	ownContent = null,
	projectionText = null,
	projectionStoredBytes = null,
	visibility = "PUBLIC",
	title = "Synthetic document",
}) {
	const own = ownContent ?? encoder.encode(`synthetic own bytes for ${versionId}`);
	const attachments = [];
	let projection = null;
	if (projectionText !== null) {
		const bytes = encoder.encode(projectionText);
		projection = { bytes, sha: sha256HexOf(bytes) };
		attachments.push({
			attachment_id: `att-${versionId}`,
			attachment_locator: `urn:riws:text-extraction:${versionId}`,
			content_sha256: projection.sha,
			byte_size: bytes.byteLength,
			media_type: "text/plain",
			display_name: "extracted-text",
			role: "text_extraction",
			attachment_status: "FETCHED",
			outcome: null,
			failure_class: null,
		});
	}
	const payload = {
		document: { document_id: documentId, title, visibility },
		version: {
			version_id: versionId,
			document_id: documentId,
			version_number: versionNumber,
			content_sha256: sha256HexOf(own),
			byte_size: own.byteLength,
			media_type: ownMediaType,
			revision_kind: revisionKind,
			readable: storedReadable,
		},
		attachments,
	};
	const row = {
		record_type: "document_version",
		record_key: versionId,
		message_id: `outbound_${payload.version.content_sha256.slice(0, 40)}`,
		visibility,
		payload_json: JSON.stringify(payload),
		generated_at: "2026-09-13T00:00:00Z",
		updated_at: "2026-09-13T00:00:00Z",
	};
	const objects = new Map([[`research-objects/sha256/${payload.version.content_sha256}`, own]]);
	if (projection) {
		objects.set(
			`research-objects/sha256/${projection.sha}`,
			projectionStoredBytes ?? projection.bytes,
		);
	}
	return { row, payload, objects };
}

function storageFrom(...parts) {
	const objects = new Map();
	for (const part of parts) {
		for (const [key, value] of part.objects) {
			if (!objects.has(key)) objects.set(key, value);
		}
	}
	return {
		db: new FakeD1(parts.map((part) => part.row)),
		objects: new FakeR2(objects),
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

test("C8 PDF version with a FETCHED text-extraction projection serves projection bytes", async () => {
	const projectionText = "extracted research narrative, synthetic projection body";
	const part = documentVersionRow({
		documentId: "doc-pdf",
		versionId: "ver-pdf-1",
		projectionText,
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	const document = await adapter.getDocument("doc-pdf");
	assert.equal(document.version.version_id, "ver-pdf-1");
	assert.equal(document.body_text, projectionText);
	assert.equal(document.body_source, "projection");
	assert.equal(document.version.readable, true);
	assert.equal(document.source, "COLLECTOR_REPLICA");
	assert.equal(document.attachments[0].role, "text_extraction");
	assert.equal(document.attachments[0].attachment_locator, "urn:riws:text-extraction:ver-pdf-1");
});

test("C8 own servable body wins over an available projection", async () => {
	const ownText = "own text/plain body bytes, synthetic";
	const part = documentVersionRow({
		documentId: "doc-text",
		versionId: "ver-text-1",
		ownMediaType: "text/plain",
		ownContent: encoder.encode(ownText),
		projectionText: "projection that must not be served when the own body is servable",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	const document = await adapter.getDocument("doc-text");
	assert.equal(document.version.version_id, "ver-text-1");
	assert.equal(document.body_text, ownText);
	assert.equal(document.body_source, "own");
	assert.equal(document.version.readable, true);
});

test("C8 PDF version without a projection is UNSUPPORTED_OPERATION", async () => {
	const part = documentVersionRow({
		documentId: "doc-bare-pdf",
		versionId: "ver-bare-pdf",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-bare-pdf"),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION" && error.retryable === false,
	);
});

test("C8 multi-version selection is deterministic on version_number DESC regardless of insert order", async () => {
	const projectionText = "newest version projection body, synthetic";
	const v1 = documentVersionRow({
		documentId: "doc-multi",
		versionId: "ver-multi-1",
		versionNumber: 1,
	});
	const v2 = documentVersionRow({
		documentId: "doc-multi",
		versionId: "ver-multi-2",
		versionNumber: 2,
		projectionText,
	});
	// Out of order: newest row inserted first.
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(v2, v1), {
		visibility: "PUBLIC",
	});
	for (let call = 0; call < 2; call += 1) {
		const document = await adapter.getDocument("doc-multi");
		assert.equal(document.version.version_id, "ver-multi-2");
		assert.equal(document.body_source, "projection");
		assert.equal(document.body_text, projectionText);
	}
});

test("C8 missing projection object falls back to the next servable version", async () => {
	const ownText = "fallback own body, synthetic";
	const v2 = documentVersionRow({
		documentId: "doc-fallback",
		versionId: "ver-fallback-2",
		versionNumber: 2,
		projectionText: "projection whose R2 object is missing",
	});
	const v1 = documentVersionRow({
		documentId: "doc-fallback",
		versionId: "ver-fallback-1",
		versionNumber: 1,
		ownMediaType: "text/plain",
		ownContent: encoder.encode(ownText),
	});
	const storage = storageFrom(v2, v1);
	for (const key of v2.objects.keys()) {
		if (key !== `research-objects/sha256/${v2.payload.version.content_sha256}`) {
			storage.objects.objects.delete(key);
		}
	}
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const document = await adapter.getDocument("doc-fallback");
	assert.equal(document.version.version_id, "ver-fallback-1");
	assert.equal(document.body_source, "own");
	assert.equal(document.body_text, ownText);
});

test("C8 every candidate object missing is STORE_UNAVAILABLE", async () => {
	const part = documentVersionRow({
		documentId: "doc-gone",
		versionId: "ver-gone-1",
		projectionText: "projection whose R2 object is missing",
	});
	const storage = storageFrom(part);
	for (const key of part.objects.keys()) {
		if (key !== `research-objects/sha256/${part.payload.version.content_sha256}`) {
			storage.objects.objects.delete(key);
		}
	}
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	await assert.rejects(
		() => adapter.getDocument("doc-gone"),
		(error) => error?.error_code === "STORE_UNAVAILABLE" && error.retryable === true,
	);
});

test("C8 tampered projection bytes fail integrity immediately without fallback", async () => {
	const tampered = encoder.encode("tampered projection bytes, synthetic");
	const v2 = documentVersionRow({
		documentId: "doc-tamper",
		versionId: "ver-tamper-2",
		versionNumber: 2,
		projectionText: "honest projection body",
		projectionStoredBytes: tampered,
	});
	const v1 = documentVersionRow({
		documentId: "doc-tamper",
		versionId: "ver-tamper-1",
		versionNumber: 1,
		ownMediaType: "text/plain",
		ownContent: encoder.encode("intact fallback body that must not be reached"),
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(v2, v1), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-tamper"),
		(error) => error?.error_code === "INTEGRITY_FAILED" && error.retryable === false,
	);
});

test("C8 searchDocuments overrides effective readable without rewriting stored payload_json", async () => {
	const unreadableStoredTrue = documentVersionRow({
		documentId: "doc-stored-true",
		versionId: "ver-stored-true",
		storedReadable: true,
	});
	const readableStoredFalse = documentVersionRow({
		documentId: "doc-stored-false",
		versionId: "ver-stored-false",
		projectionText: "projection makes this PDF readable",
	});
	const storage = storageFrom(unreadableStoredTrue, readableStoredFalse);
	const storedBefore = storage.db.records.map((row) => row.payload_json);
	const adapter = new remote.CollectorResearchRemoteAdapter(storage, { visibility: "PUBLIC" });
	const views = await adapter.searchDocuments();
	assert.equal(views.length, 2);
	const byId = new Map(views.map((view) => [view.payload.version.version_id, view]));
	assert.equal(byId.get("ver-stored-true").payload.version.readable, false);
	assert.equal(byId.get("ver-stored-false").payload.version.readable, true);
	assert.deepEqual(
		storage.db.records.map((row) => row.payload_json),
		storedBefore,
	);
});

test("C8 WITHDRAWAL-only document is never servable on either read face", async () => {
	const part = documentVersionRow({
		documentId: "doc-withdrawn",
		versionId: "ver-withdrawn",
		revisionKind: "WITHDRAWAL",
		storedReadable: false,
		projectionText: "projection that cannot rescue a WITHDRAWAL version",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-withdrawn"),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION",
	);
	const views = await adapter.searchDocuments();
	assert.equal(views.length, 1);
	assert.equal(views[0].payload.version.readable, false);
});

test("C8 media type parameters are stripped before exact-match servability", async () => {
	const ownText = '{"synthetic":"json body with a parameterized media type"}';
	const part = documentVersionRow({
		documentId: "doc-json-params",
		versionId: "ver-json-params",
		ownMediaType: "application/json; charset=utf-8",
		ownContent: encoder.encode(ownText),
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	const document = await adapter.getDocument("doc-json-params");
	assert.equal(document.version.version_id, "ver-json-params");
	assert.equal(document.body_source, "own");
	assert.equal(document.body_text, ownText);
	assert.equal(document.version.readable, true);
	const views = await adapter.searchDocuments();
	assert.equal(views.length, 1);
	assert.equal(views[0].payload.version.readable, true);
});

test("C8 fabricated document id is NOT_FOUND", async () => {
	const part = documentVersionRow({
		documentId: "doc-real",
		versionId: "ver-real",
		projectionText: "projection body",
	});
	const adapter = new remote.CollectorResearchRemoteAdapter(storageFrom(part), {
		visibility: "PUBLIC",
	});
	await assert.rejects(
		() => adapter.getDocument("doc-fabricated"),
		(error) => error?.error_code === "NOT_FOUND",
	);
});
