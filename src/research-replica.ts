/**
 * C5 Collector-owned Research replica.  Research sends validated outbound-v2
 * records to this boundary; it never exposes its SQLite file, file paths, or
 * a remote database connection.  R2 is private storage, not a public origin.
 */
import {
	ResearchBoundaryError,
	outboundV2RecordKey,
	verifyOutboundV2ObjectChunks,
	verifyOutboundV2Record,
	type OutboundV2Record,
} from "./research-outbound-v2.ts";

export type ResearchReplicaStorage = {
	db: D1Database;
	objects: R2Bucket;
};

export type ReplicaIngestResult = {
	status: "APPLIED" | "REPLAY";
	message_id: string;
	record_type: string;
	content_sha256: string | null;
};

type ReplicaHealthRow = {
	last_attempt_at: string | null;
	last_success_at: string | null;
	last_message_id: string | null;
	last_error_code: string | null;
	accepted_messages: number;
};

function safeFailure(
	code: "INTEGRITY_FAILED" | "STORE_UNAVAILABLE" | "UNSUPPORTED_OPERATION",
): never {
	throw new ResearchBoundaryError(code);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectKey(contentSha256: string): string {
	return `research-objects/sha256/${contentSha256}`;
}

function journalKey(messageId: string): string {
	return `research-replica-journal/v2/${messageId}.json`;
}

function documentObjectLinks(record: OutboundV2Record): Array<[string, string]> {
	if (record.record_type !== "document_version") return [];
	const version = record.payload.version as Record<string, unknown>;
	const attachments = record.payload.attachments as Array<Record<string, unknown>>;
	return [
		["document_body", String(version.content_sha256)],
		...attachments.map((attachment): [string, string] => [
			`attachment:${String(attachment.attachment_id)}`,
			String(attachment.content_sha256),
		]),
	];
}

function objectContentHash(record: OutboundV2Record): string | null {
	return record.record_type === "object" ? String(record.payload.content_sha256) : null;
}

/**
 * Store one verified message.  Re-applying the same message is a no-op for
 * logical state and reports REPLAY.  The immutable R2 journal permits safe
 * D1 recovery by sending the same record again through this function.
 */
export async function ingestResearchReplicaRecord(
	storage: ResearchReplicaStorage,
	rawRecord: unknown,
	objectChunks: Iterable<Uint8Array> | null = null,
	now = new Date().toISOString(),
): Promise<ReplicaIngestResult> {
	let record: OutboundV2Record;
	try {
		const rawRecordType =
			rawRecord && typeof rawRecord === "object"
				? (rawRecord as { record_type?: unknown }).record_type
				: undefined;
		record =
			rawRecordType === "object"
				? await verifyOutboundV2ObjectChunks(rawRecord, objectChunks ?? [])
				: await verifyOutboundV2Record(rawRecord);
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		safeFailure("INTEGRITY_FAILED");
	}

	if (record.record_type !== "object" && objectChunks !== null)
		safeFailure("UNSUPPORTED_OPERATION");
	const key = outboundV2RecordKey(record);
	const payloadJson = canonicalJson(record.payload);
	const payloadSha256 = await sha256Hex(payloadJson);
	const contentSha256 = objectContentHash(record);

	try {
		// The journal is the recovery source for metadata.  It contains the
		// validated, path-free outbound envelope and is idempotent by message id.
		await storage.objects.put(journalKey(record.message_id), canonicalJson(record), {
			httpMetadata: { contentType: "application/json; charset=utf-8" },
		});
		if (contentSha256) {
			const chunks = [...(objectChunks ?? [])];
			const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
			const body = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			await storage.objects.put(objectKey(contentSha256), body, {
				httpMetadata: { contentType: String(record.payload.media_type) },
				customMetadata: { content_sha256: contentSha256, visibility: record.visibility },
			});
		}

		const statements = [
			storage.db
				.prepare(
					"INSERT OR IGNORE INTO research_ingest_messages (message_id, record_type, record_key, visibility, payload_sha256, generated_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					record.message_id,
					record.record_type,
					key,
					record.visibility,
					payloadSha256,
					record.generated_at,
					now,
				),
			storage.db
				.prepare(
					"INSERT INTO research_records (record_type, record_key, message_id, visibility, payload_json, generated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_type, record_key) DO UPDATE SET message_id=excluded.message_id, visibility=excluded.visibility, payload_json=excluded.payload_json, generated_at=excluded.generated_at, updated_at=excluded.updated_at",
				)
				.bind(
					record.record_type,
					key,
					record.message_id,
					record.visibility,
					payloadJson,
					record.generated_at,
					now,
				),
		];
		if (contentSha256) {
			statements.push(
				storage.db
					.prepare(
						"INSERT INTO research_objects (content_sha256, message_id, visibility, media_type, byte_size, state, received_at) VALUES (?, ?, ?, ?, ?, 'READY', ?) ON CONFLICT(content_sha256) DO UPDATE SET message_id=excluded.message_id, visibility=excluded.visibility, media_type=excluded.media_type, byte_size=excluded.byte_size, state='READY', received_at=excluded.received_at",
					)
					.bind(
						contentSha256,
						record.message_id,
						record.visibility,
						String(record.payload.media_type),
						Number(record.payload.byte_size),
						now,
					),
			);
		}
		for (const [role, linkedHash] of documentObjectLinks(record)) {
			statements.push(
				storage.db
					.prepare(
						"INSERT INTO research_record_objects (record_type, record_key, role, content_sha256, visibility) VALUES (?, ?, ?, ?, ?) ON CONFLICT(record_type, record_key, role, content_sha256) DO UPDATE SET visibility=excluded.visibility",
					)
					.bind(record.record_type, key, role, linkedHash, record.visibility),
			);
		}
		const results = await storage.db.batch(statements);
		const inserted = Number(results[0]?.meta.changes ?? 0) === 1;
		await storage.db
			.prepare(
				"UPDATE research_replica_health SET last_attempt_at=?, last_success_at=?, last_message_id=?, last_error_code=NULL, accepted_messages=accepted_messages + ? WHERE name='primary'",
			)
			.bind(now, now, record.message_id, inserted ? 1 : 0)
			.run();
		return {
			status: inserted ? "APPLIED" : "REPLAY",
			message_id: record.message_id,
			record_type: record.record_type,
			content_sha256: contentSha256,
		};
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		try {
			await storage.db
				.prepare(
					"UPDATE research_replica_health SET last_attempt_at=?, last_error_code='STORE_UNAVAILABLE' WHERE name='primary'",
				)
				.bind(now)
				.run();
		} catch {
			// The caller still gets the same closed error if health itself is unavailable.
		}
		safeFailure("STORE_UNAVAILABLE");
	}
}

export async function readResearchReplicaHealth(
	storage: ResearchReplicaStorage,
): Promise<ReplicaHealthRow> {
	try {
		const row = await storage.db
			.prepare(
				"SELECT last_attempt_at, last_success_at, last_message_id, last_error_code, accepted_messages FROM research_replica_health WHERE name='primary'",
			)
			.first<ReplicaHealthRow>();
		if (!row) safeFailure("STORE_UNAVAILABLE");
		return row;
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		safeFailure("STORE_UNAVAILABLE");
	}
}
