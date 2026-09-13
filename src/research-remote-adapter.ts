/**
 * C6 read-only adapter over the Collector-owned D1/R2 replica.
 *
 * This is deliberately independent from Research's local SQLite adapter: it
 * receives only the validated outbound-v2 projection previously persisted by
 * C5, and it has no filesystem, LIVE, QMT, or write-plane capability.
 *
 * Shared read-plane contract (SPEC-C8 §3.2/§3.3/§3.4; the RESEARCH producer
 * side mirrors the same five points):
 *
 * 1. Projection role constant: "text_extraction".  A text-extraction
 *    projection travels as an attachment on the document_version payload with
 *    attachment_locator "urn:riws:text-extraction:<version_id>",
 *    attachment_status "FETCHED", media_type "text/plain", and the extracted
 *    text bytes addressed by content_sha256.
 * 2. Servable media_type whitelist (readableMediaType below): media_type
 *    lowercased starts with "text/", or is exactly application/json,
 *    application/xml, or application/xhtml+xml.
 * 3. readable semantics (effective value; stored payload_json is never
 *    rewritten): a version is servable iff
 *      revision_kind != "WITHDRAWAL"
 *      AND ( (whitelisted own media_type AND 64-hex own content_sha256)
 *            OR (exists attachment with role "text_extraction" AND
 *                attachment_status "FETCHED" AND whitelisted media_type AND
 *                64-hex content_sha256) ).
 *    Both the list face (searchDocuments) and the detail face (getDocument)
 *    present this same effective value; WITHDRAWAL versions are never
 *    servable.
 * 4. getDocument determinism: every version row of a document_id is fetched
 *    and ordered by version_number DESC with record_key (version_id)
 *    lexicographic ASC as tiebreak; the first servable version is served,
 *    own body bytes preferred over its projection.
 * 5. Failure model: served bytes are SHA-256 re-verified (mismatch ->
 *    INTEGRITY_FAILED immediately, no fallback); a candidate object missing
 *    in R2 falls through to the next servable version; every candidate
 *    object missing -> STORE_UNAVAILABLE; no servable version at all ->
 *    UNSUPPORTED_OPERATION.  Successful responses add
 *    body_source: "own" | "projection" and present version.readable === true.
 */
import type { ResearchReplicaStorage } from "./research-replica.ts";
import { ResearchBoundaryError } from "./research-outbound-v2.ts";

export type ResearchReadVisibility = "PUBLIC" | "PRIVATE";

/** Shared contract constant (SPEC-C8 §3.4): the text-extraction projection role. */
const TEXT_EXTRACTION_ROLE = "text_extraction";

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
	let mediaType = String(value ?? "").toLowerCase();
	// Media type parameters (e.g. "; charset=utf-8") do not change servability;
	// strip them before the exact matches so "application/json; charset=utf-8"
	// stays servable on both sides (the Collector is deliberately the wider
	// side of the readable=true => get_document implication).  The "text/"
	// prefix branch is unaffected either way.
	const parameterStart = mediaType.indexOf(";");
	if (parameterStart >= 0) mediaType = mediaType.slice(0, parameterStart).trimEnd();
	return mediaType.startsWith("text/") || /^(application\/json|application\/xml|application\/xhtml\+xml)$/.test(mediaType);
}

function isHexSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The servable body of one document_version payload: its own bytes when the
 * own media_type is whitelisted and its reference hash is well-formed,
 * otherwise its text-extraction projection attachment.  Returns null when the
 * version is not servable at all (WITHDRAWAL never is; see the module header
 * for the authoritative formula).
 */
type ServableBody = { bodySource: "own" | "projection"; contentSha256: string };

function servableBody(payload: Record<string, unknown>): ServableBody | null {
	const version = payload.version as Record<string, unknown> | undefined;
	if (!version || typeof version !== "object" || version.revision_kind === "WITHDRAWAL") {
		return null;
	}
	const ownSha256 = version.content_sha256;
	if (readableMediaType(version.media_type) && isHexSha256(ownSha256)) {
		return { bodySource: "own", contentSha256: ownSha256 };
	}
	const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
	for (const attachment of attachments) {
		if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
		const record = attachment as Record<string, unknown>;
		const projectionSha256 = record.content_sha256;
		if (
			record.role === TEXT_EXTRACTION_ROLE &&
			record.attachment_status === "FETCHED" &&
			readableMediaType(record.media_type) &&
			isHexSha256(projectionSha256)
		) {
			return { bodySource: "projection", contentSha256: projectionSha256 };
		}
	}
	return null;
}

/**
 * Shared servable predicate behind both the list face and the detail face:
 * readable = servable (SPEC-C8 §3.2).  Purely derived from the already parsed
 * payload; it never mutates the stored record.
 */
function isVersionServable(payload: Record<string, unknown>): boolean {
	return servableBody(payload) !== null;
}

function numericVersionNumber(version: Record<string, unknown>): number {
	const value = Number(version.version_number);
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
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
			.map((row) => {
				const view = recordView(row);
				// Effective readable (SPEC-C8 §3.3): recomputed from the same
				// servable predicate the detail face uses, so readable=true always
				// means getDocument can actually serve a body.  The view holds a
				// freshly parsed object; the stored payload_json stays untouched.
				const payload = view.payload as Record<string, unknown>;
				const version = payload.version as Record<string, unknown> | undefined;
				if (version && typeof version === "object") {
					version.readable = isVersionServable(payload);
				}
				return view;
			});
	}

	async getDocument(documentId: string): Promise<Record<string, unknown>> {
		if (!documentId) fail("INTEGRITY_FAILED");
		const rows = await this.guarded(async () => {
			const result = await this.storage.db
				.prepare(
					"SELECT record_type, record_key, message_id, visibility, payload_json, generated_at, updated_at FROM research_records WHERE record_type='document_version' AND visibility=? AND json_extract(payload_json, '$.document.document_id')=?",
				)
				.bind(this.visibility, documentId)
				.all<ReplicaRecordRow>();
			return result.results ?? [];
		});
		if (rows.length === 0) fail("NOT_FOUND");
		const candidates = rows.map((row) => {
			const payload = parsePayload(row);
			const document = payload.document as Record<string, unknown>;
			const version = payload.version as Record<string, unknown>;
			if (!document || !version || document.document_id !== documentId) fail("INTEGRITY_FAILED");
			return { row, payload, version };
		});
		// Deterministic order (SPEC-C8 §3.3): version_number DESC, record_key
		// (version_id) lexicographic ASC as tiebreak.
		candidates.sort((a, b) => {
			const delta = numericVersionNumber(b.version) - numericVersionNumber(a.version);
			if (delta !== 0) return delta;
			if (a.row.record_key < b.row.record_key) return -1;
			if (a.row.record_key > b.row.record_key) return 1;
			return 0;
		});
		let sawServable = false;
		for (const candidate of candidates) {
			const body = servableBody(candidate.payload);
			if (!body) continue;
			sawServable = true;
			const object = await this.guarded(() => this.storage.objects.get(objectKey(body.contentSha256)));
			// Candidate object missing in R2: fall through to the next servable
			// version (missing bytes is a retryable availability problem).
			if (!object) continue;
			const bytes = await this.guarded(() => object.arrayBuffer());
			// Corrupted bytes must be exposed, never silently skipped.
			if ((await sha256Hex(bytes)) !== body.contentSha256) fail("INTEGRITY_FAILED");
			return {
				document: candidate.payload.document,
				version: { ...candidate.version, readable: true },
				attachments: candidate.payload.attachments,
				body_text: new TextDecoder().decode(bytes),
				body_source: body.bodySource,
				source: "COLLECTOR_REPLICA",
			};
		}
		fail(sawServable ? "STORE_UNAVAILABLE" : "UNSUPPORTED_OPERATION");
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
