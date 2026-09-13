/**
 * C6 read-only adapter over the Collector-owned D1/R2 replica.
 *
 * This is deliberately independent from Research's local SQLite adapter: it
 * receives only the validated outbound-v2 projection previously persisted by
 * C5, and it has no filesystem, LIVE, QMT, or write-plane capability.
 */
import type { ResearchReplicaStorage } from "./research-replica.ts";
import { ResearchBoundaryError } from "./research-outbound-v2.ts";

export type ResearchReadVisibility = "PUBLIC" | "PRIVATE";

type ReplicaRecordRow = {
	record_type: string;
	record_key: string;
	message_id: string;
	visibility: ResearchReadVisibility;
	payload_json: string;
	generated_at: string | null;
	updated_at: string;
};

type RemoteAdapterOptions = {
	/** Exactly one research-read scope; PUBLIC never falls through to PRIVATE. */
	visibility?: ResearchReadVisibility;
};

function fail(code: "NOT_FOUND" | "STORE_UNAVAILABLE" | "INTEGRITY_FAILED" | "UNSUPPORTED_OPERATION"): never {
	throw new ResearchBoundaryError(code);
}

function boundedLimit(value: number | undefined): number {
	if (value === undefined) return 50;
	if (!Number.isInteger(value) || value < 1 || value > 100) fail("INTEGRITY_FAILED");
	return value;
}

function parsePayload(row: ReplicaRecordRow): Record<string, unknown> {
	try {
		const payload = JSON.parse(row.payload_json);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INTEGRITY_FAILED");
		return payload as Record<string, unknown>;
	} catch (error) {
		if (error instanceof ResearchBoundaryError) throw error;
		fail("INTEGRITY_FAILED");
	}
}

function recordView(row: ReplicaRecordRow): Record<string, unknown> {
	return {
		record_type: row.record_type,
		record_key: row.record_key,
		message_id: row.message_id,
		visibility: row.visibility,
		payload: parsePayload(row),
		generated_at: row.generated_at,
		updated_at: row.updated_at,
		source: "COLLECTOR_REPLICA",
	};
}

function objectKey(contentSha256: string): string {
	return `research-objects/sha256/${contentSha256}`;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", value);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readableMediaType(value: unknown): boolean {
	const mediaType = String(value ?? "").toLowerCase();
	return mediaType.startsWith("text/") || /^(application\/json|application\/xml|application\/xhtml\+xml)$/.test(mediaType);
}

/**
 * The only remote research adapter used by the ChatGPT-facing Collector.
 * C7 will expose its methods as tools; this class itself performs no request
 * routing and does not share any market/LIVE authorization state.
 */
export class CollectorResearchRemoteAdapter {
	readonly visibility: ResearchReadVisibility;
	private readonly storage: ResearchReplicaStorage;

	constructor(
		storage: ResearchReplicaStorage,
		options: RemoteAdapterOptions = {},
	) {
		this.storage = storage;
		this.visibility = options.visibility ?? "PUBLIC";
		if (this.visibility !== "PUBLIC" && this.visibility !== "PRIVATE") fail("INTEGRITY_FAILED");
	}

	private async guarded<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ResearchBoundaryError) throw error;
			fail("STORE_UNAVAILABLE");
		}
	}

	private async records(recordType: string, limit?: number): Promise<ReplicaRecordRow[]> {
		return this.guarded(async () => {
			const result = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, payload_json, generated_at, updated_at FROM research_records WHERE record_type=? AND visibility=? ORDER BY updated_at DESC LIMIT ?",
				)
				.bind(recordType, this.visibility, boundedLimit(limit))
				.all<ReplicaRecordRow>();
			return result.results ?? [];
		});
	}

	private async recordByKey(recordType: string, recordKey: string): Promise<ReplicaRecordRow> {
		if (!recordKey) fail("INTEGRITY_FAILED");
		return this.guarded(async () => {
			const row = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, payload_json, generated_at, updated_at FROM research_records WHERE record_type=? AND record_key=? AND visibility=? LIMIT 1",
				)
				.bind(recordType, recordKey, this.visibility)
				.first<ReplicaRecordRow>();
			if (!row) fail("NOT_FOUND");
			return row;
		});
	}

	async searchDocuments(query?: string, limit?: number): Promise<Array<Record<string, unknown>>> {
		const needle = query?.trim().toLocaleLowerCase();
		return (await this.records("document_version", limit))
			.filter((row) => {
				if (!needle) return true;
				const document = parsePayload(row).document as Record<string, unknown>;
				return String(document?.title ?? "").toLocaleLowerCase().includes(needle);
			})
			.map(recordView);
	}

	async getDocument(documentId: string): Promise<Record<string, unknown>> {
		if (!documentId) fail("INTEGRITY_FAILED");
		const row = await this.guarded(async () => {
			const value = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, payload_json, generated_at, updated_at FROM research_records WHERE record_type='document_version' AND visibility=? AND json_extract(payload_json, '$.document.document_id')=? LIMIT 1",
				)
				.bind(this.visibility, documentId)
				.first<ReplicaRecordRow>();
			if (!value) fail("NOT_FOUND");
			return value;
		});
		const payload = parsePayload(row);
		const document = payload.document as Record<string, unknown>;
		const version = payload.version as Record<string, unknown>;
		if (!document || !version || document.document_id !== documentId) fail("INTEGRITY_FAILED");
		if (!readableMediaType(version.media_type)) fail("UNSUPPORTED_OPERATION");
		const contentSha256 = String(version.content_sha256 ?? "");
		if (!/^[0-9a-f]{64}$/.test(contentSha256)) fail("INTEGRITY_FAILED");
		const object = await this.guarded(() => this.storage.objects.get(objectKey(contentSha256)));
		if (!object) fail("STORE_UNAVAILABLE");
		const bytes = await this.guarded(() => object.arrayBuffer());
		if ((await sha256Hex(bytes)) !== contentSha256) fail("INTEGRITY_FAILED");
		return {
			document,
			version,
			attachments: payload.attachments,
			body_text: new TextDecoder().decode(bytes),
			source: "COLLECTOR_REPLICA",
		};
	}

	async searchEvidence(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this.records("evidence", limit)).map(recordView);
	}

	async getEvidence(evidenceId: string): Promise<Record<string, unknown>> {
		return recordView(await this.recordByKey("evidence", evidenceId));
	}

	async getThemeAccumulator(subjectKey: string): Promise<Record<string, unknown>> {
		for (const row of await this.records("accumulator", 100)) {
			const payload = parsePayload(row);
			if (payload.subject_key === subjectKey) return recordView(row);
		}
		fail("NOT_FOUND");
	}

	async getCompanyEvidenceState(company: string): Promise<Record<string, unknown>> {
		return this.getThemeAccumulator(company);
	}

	async getCoverageStatus(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this.records("coverage", limit)).map(recordView);
	}

	async getSourceHealth(): Promise<never> {
		// C5 does not replicate detailed source-health observations.  A caller
		// must receive an explicit unsupported result, never an empty success.
		fail("UNSUPPORTED_OPERATION");
	}

	async listResearchJobs(limit?: number): Promise<Array<Record<string, unknown>>> {
		return (await this.records("job", limit)).map(recordView);
	}

	async getResearchJobContext(jobId: string): Promise<Record<string, unknown>> {
		return recordView(await this.recordByKey("job", jobId));
	}
}
