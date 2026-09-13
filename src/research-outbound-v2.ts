/**
 * Consumer-side contract for the immutable RIWS `collector-outbound-v2`
 * stream.  This module intentionally owns validation only: it has no access
 * to Research SQLite, local paths, LIVE, QMT, or any write-plane operation.
 */

export const OUTBOUND_V2_SCHEMA_VERSION = "collector-outbound-v2";

const RECORD_TYPES = new Set([
	"source",
	"document_version",
	"evidence",
	"coverage",
	"accumulator",
	"job",
	"object",
]);
const VISIBILITIES = new Set(["PUBLIC", "PRIVATE"]);
const ERROR_CODES = new Set([
	"NOT_FOUND",
	"FILTERED",
	"STORE_UNAVAILABLE",
	"INTEGRITY_FAILED",
	"UNSUPPORTED_OPERATION",
	"RATE_LIMITED",
]);
const SAFE_MESSAGES: Record<string, string> = {
	NOT_FOUND: "requested record was not found",
	FILTERED: "request filtered by visibility or validation policy",
	STORE_UNAVAILABLE: "local store is temporarily unavailable",
	INTEGRITY_FAILED: "integrity verification failed",
	UNSUPPORTED_OPERATION: "operation is not supported by this boundary",
	RATE_LIMITED: "rate limited; retry later",
};
const HIDDEN_KEYS = new Set([
	"object_key",
	"path",
	"absolute_path",
	"local_path",
	"file_path",
	"text",
	"excerpt",
	"raw_content",
	"content",
	"token",
	"access_token",
	"refresh_token",
	"cookie",
	"set-cookie",
	"authorization",
	"chatgpt_identity",
	"lease_owner_hash",
]);
const RESPONSE_HEADERS = new Set(["content-type", "etag", "last-modified", "content-length"]);
const ENVELOPE_KEYS = [
	"record_type",
	"message_id",
	"schema_version",
	"policy_version",
	"visibility",
	"payload",
	"generated_at",
];

const PAYLOAD_KEYS: Record<string, readonly string[]> = {
	source: [
		"source_id",
		"name",
		"provider",
		"source_kind",
		"canonical_base",
		"visibility",
		"lifecycle",
		"check_frequency_seconds",
		"policy_version",
		"last_health_at",
	],
	coverage: [
		"coverage_id",
		"source_id",
		"subject",
		"metric_type",
		"rule_key",
		"status",
		"alternative_coverage_id",
		"next_check_at",
		"visibility",
		"updated_at",
	],
	accumulator: [
		"snapshot_id",
		"subject_key",
		"evidence_ids",
		"total_weight",
		"dimensions",
		"independent_cluster_count",
		"unknown_cluster_count",
		"conflict_count",
		"last_evidence_at",
		"rule_version",
		"status",
		"created_at",
		"visibility",
	],
	job: [
		"job_id",
		"dedupe_key",
		"status",
		"priority",
		"theme",
		"company",
		"question",
		"missing_dimensions_json",
		"counter_evidence_request",
		"accumulator_snapshot_id",
		"coverage_gap_json",
		"priority_reason",
		"deadline",
		"recheck_at",
		"budget_hint",
		"historical_backfill",
		"created_at",
		"updated_at",
		"policy_version",
		"visibility",
	],
	object: [
		"object_id",
		"content_sha256",
		"media_type",
		"byte_size",
		"visibility",
		"encoding",
		"chunking",
		"manifest_message_id",
	],
};
const DOCUMENT_KEYS = [
	"document_id",
	"source_id",
	"source_identity_key",
	"canonical_locator",
	"origin_locator",
	"first_seen_at",
	"title",
	"source_kind",
	"visibility",
	"historical_backfill",
];
const VERSION_KEYS = [
	"version_id",
	"document_id",
	"version_number",
	"content_sha256",
	"byte_size",
	"media_type",
	"ingested_at",
	"published_at",
	"event_time",
	"source_updated_at",
	"response_headers",
	"revision_kind",
	"corrects_version_id",
	"historical_backfill",
	"readable",
];
const ATTACHMENT_KEYS = [
	"attachment_id",
	"attachment_locator",
	"content_sha256",
	"byte_size",
	"media_type",
	"display_name",
	"role",
	"attachment_status",
	"outcome",
	"failure_class",
];
const EVIDENCE_KEYS = [
	"evidence_id",
	"claim_id",
	"evidence_type",
	"direction",
	"fact_root_id",
	"independence_cluster_id",
	"duplicate_of_evidence_id",
	"source_id",
	"theme",
	"company",
	"confidence",
	"visibility",
	"decay_policy",
	"validity",
	"created_at",
	"policy_version",
	"independence_status",
	"historical_backfill",
	"claim",
];
const CLAIM_KEYS = [
	"subject",
	"predicate",
	"value",
	"unit",
	"scope",
	"methodology",
	"event_time",
	"extraction_method",
	"extraction_confidence",
	"source_span_hash",
];

export type ResearchErrorCode = keyof typeof SAFE_MESSAGES;
export type ResearchError = {
	error_code: ResearchErrorCode;
	safe_message: string;
	retryable: boolean;
	request_id: string;
};
export type OutboundV2Record = {
	record_type: string;
	message_id: string;
	schema_version: string;
	policy_version: string;
	visibility: "PUBLIC" | "PRIVATE";
	payload: Record<string, unknown>;
	generated_at: string | null;
};

export class ResearchBoundaryError extends Error implements ResearchError {
	readonly error_code: ResearchErrorCode;
	readonly safe_message: string;
	readonly retryable: boolean;
	readonly request_id: string;

	constructor(errorCode: ResearchErrorCode, requestId = crypto.randomUUID().replaceAll("-", "")) {
		super(SAFE_MESSAGES[errorCode]);
		this.name = "ResearchBoundaryError";
		this.error_code = errorCode;
		this.safe_message = SAFE_MESSAGES[errorCode];
		this.retryable = errorCode === "STORE_UNAVAILABLE" || errorCode === "RATE_LIMITED";
		this.request_id = requestId;
	}

	asError(): ResearchError {
		return {
			error_code: this.error_code,
			safe_message: this.safe_message,
			retryable: this.retryable,
			request_id: this.request_id,
		};
	}
}

function fail(errorCode: ResearchErrorCode): never {
	throw new ResearchBoundaryError(errorCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (
		keys.length !== sortedExpected.length ||
		keys.some((key, index) => key !== sortedExpected[index])
	) {
		fail("INTEGRITY_FAILED");
	}
}

function stringField(value: unknown): string {
	if (typeof value !== "string" || !value) fail("INTEGRITY_FAILED");
	return value;
}

function visibilityField(value: unknown): "PUBLIC" | "PRIVATE" {
	if (typeof value !== "string" || !VISIBILITIES.has(value)) fail("FILTERED");
	return value as "PUBLIC" | "PRIVATE";
}

function hexField(value: unknown): string {
	const text = stringField(value);
	if (!/^[0-9a-f]{64}$/.test(text)) fail("INTEGRITY_FAILED");
	return text;
}

/** Reject a payload that would expose hidden body, credentials, or local paths. */
export function assertOutboundV2PayloadSafe(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertOutboundV2PayloadSafe(item);
		return;
	}
	if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			const normalized = key.toLowerCase();
			if (HIDDEN_KEYS.has(normalized)) fail("INTEGRITY_FAILED");
			if (normalized === "response_headers" && isRecord(item)) {
				for (const header of Object.keys(item)) {
					if (!RESPONSE_HEADERS.has(header.toLowerCase())) fail("INTEGRITY_FAILED");
				}
			}
			assertOutboundV2PayloadSafe(item);
		}
		return;
	}
	if (
		typeof value === "string" &&
		(/^[A-Za-z]:[\\/]/.test(value) || value.includes("/home/") || value.includes("/Users/"))
	) {
		fail("INTEGRITY_FAILED");
	}
}

export function assertResearchVisibility(value: unknown): "PUBLIC" | "PRIVATE" {
	return visibilityField(value);
}

/**
 * The producer is Python.  Its typed float fields preserve a trailing `.0`
 * (for example, `extraction_confidence: 1.0`) in the canonical material used
 * to derive a message id.  JSON.parse loses that distinction, so restore it
 * only for the float fields defined by outbound-v2.
 */
const PYTHON_FLOAT_PATHS = new Set(["confidence", "claim.extraction_confidence", "total_weight"]);

function canonicalJson(value: unknown, path: readonly string[] = []): string {
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item, path)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], [...path, key])}`)
			.join(",")}}`;
	}
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		PYTHON_FLOAT_PATHS.has(path.join("."))
	) {
		return `${value}.0`;
	}
	return JSON.stringify(value);
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recordKey(record: OutboundV2Record): string {
	const payload = record.payload;
	switch (record.record_type) {
		case "object":
			return hexField(payload.content_sha256);
		case "source":
			return stringField(payload.source_id);
		case "document_version":
			return stringField((payload.version as Record<string, unknown>)?.version_id);
		case "evidence":
			return stringField(payload.evidence_id);
		case "coverage":
			return stringField(payload.coverage_id);
		case "accumulator":
			return stringField(payload.snapshot_id);
		case "job":
			return stringField(payload.job_id);
		default:
			return fail("UNSUPPORTED_OPERATION");
	}
}

export async function computeOutboundV2MessageId(record: OutboundV2Record): Promise<string> {
	const material =
		record.record_type === "object"
			? Object.fromEntries(
					Object.entries(record.payload).filter(([key]) => key !== "manifest_message_id"),
				)
			: record.payload;
	const input = [
		record.schema_version,
		record.record_type,
		recordKey(record),
		canonicalJson(material),
	].join("\x1f");
	return `outbound_${(await sha256Hex(input)).slice(0, 40)}`;
}

function validateNestedPayload(record: OutboundV2Record): void {
	const payload = record.payload;
	if (record.record_type === "document_version") {
		exactKeys(payload, ["document", "version", "attachments"]);
		if (
			!isRecord(payload.document) ||
			!isRecord(payload.version) ||
			!Array.isArray(payload.attachments)
		) {
			fail("INTEGRITY_FAILED");
		}
		exactKeys(payload.document, DOCUMENT_KEYS);
		exactKeys(payload.version, VERSION_KEYS);
		for (const attachment of payload.attachments) {
			if (!isRecord(attachment)) fail("INTEGRITY_FAILED");
			exactKeys(attachment, ATTACHMENT_KEYS);
		}
		if (visibilityField(payload.document.visibility) !== record.visibility) fail("FILTERED");
		return;
	}
	if (record.record_type === "evidence") {
		exactKeys(payload, EVIDENCE_KEYS);
		if (!isRecord(payload.claim)) fail("INTEGRITY_FAILED");
		exactKeys(payload.claim, CLAIM_KEYS);
	}
	if (record.record_type === "accumulator") {
		exactKeys(payload, PAYLOAD_KEYS.accumulator);
		if (!isRecord(payload.dimensions)) fail("INTEGRITY_FAILED");
		exactKeys(payload.dimensions, ["D", "S", "M", "E", "P", "C"]);
	}
	if (record.record_type === "job") {
		exactKeys(payload, PAYLOAD_KEYS.job);
		if (payload.status !== "QUEUED") fail("FILTERED");
	}
	if (record.record_type === "object") {
		exactKeys(payload, PAYLOAD_KEYS.object);
		if (payload.object_id !== payload.content_sha256 || payload.encoding !== "identity") {
			fail("INTEGRITY_FAILED");
		}
		if (!isRecord(payload.chunking)) fail("INTEGRITY_FAILED");
		exactKeys(payload.chunking, ["chunked", "chunk_size", "total_chunks", "chunk_sha256"]);
		if (!Array.isArray(payload.chunking.chunk_sha256)) fail("INTEGRITY_FAILED");
		if (payload.chunking.total_chunks !== payload.chunking.chunk_sha256.length)
			fail("INTEGRITY_FAILED");
		if (payload.manifest_message_id !== record.message_id) fail("INTEGRITY_FAILED");
	}
	if (
		record.record_type in PAYLOAD_KEYS &&
		record.record_type !== "accumulator" &&
		record.record_type !== "job" &&
		record.record_type !== "object"
	) {
		exactKeys(payload, PAYLOAD_KEYS[record.record_type]);
	}
	if (
		record.record_type !== "document_version" &&
		visibilityField(payload.visibility) !== record.visibility
	) {
		fail("FILTERED");
	}
}

export function validateOutboundV2Record(value: unknown): OutboundV2Record {
	if (!isRecord(value)) fail("INTEGRITY_FAILED");
	exactKeys(value, ENVELOPE_KEYS);
	if (value.schema_version !== OUTBOUND_V2_SCHEMA_VERSION) fail("UNSUPPORTED_OPERATION");
	if (typeof value.record_type !== "string" || !RECORD_TYPES.has(value.record_type)) {
		fail("UNSUPPORTED_OPERATION");
	}
	if (!/^outbound_[0-9a-f]{40}$/.test(stringField(value.message_id))) fail("INTEGRITY_FAILED");
	stringField(value.policy_version);
	if (value.generated_at !== null && typeof value.generated_at !== "string")
		fail("INTEGRITY_FAILED");
	if (!isRecord(value.payload)) fail("INTEGRITY_FAILED");
	const record: OutboundV2Record = {
		record_type: stringField(value.record_type),
		message_id: stringField(value.message_id),
		schema_version: value.schema_version,
		policy_version: stringField(value.policy_version),
		visibility: visibilityField(value.visibility),
		payload: value.payload,
		generated_at: value.generated_at,
	};
	assertOutboundV2PayloadSafe(record.payload);
	validateNestedPayload(record);
	return record;
}

export async function verifyOutboundV2Record(value: unknown): Promise<OutboundV2Record> {
	const record = validateOutboundV2Record(value);
	if ((await computeOutboundV2MessageId(record)) !== record.message_id) fail("INTEGRITY_FAILED");
	return record;
}

export async function verifyOutboundV2ObjectChunks(
	value: unknown,
	chunks: Iterable<Uint8Array>,
): Promise<OutboundV2Record> {
	const record = await verifyOutboundV2Record(value);
	if (record.record_type !== "object") fail("UNSUPPORTED_OPERATION");
	const manifest = record.payload.chunking as Record<string, unknown>;
	const supplied = [...chunks].map((chunk) => new Uint8Array(chunk));
	const expected = manifest.chunk_sha256 as unknown[];
	if (supplied.length !== expected.length) fail("INTEGRITY_FAILED");
	for (let index = 0; index < supplied.length; index += 1) {
		if ((await sha256Hex(supplied[index])) !== expected[index]) fail("INTEGRITY_FAILED");
	}
	const total = supplied.reduce((size, chunk) => size + chunk.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of supplied) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (
		(await sha256Hex(joined)) !== record.payload.content_sha256 ||
		total !== record.payload.byte_size
	) {
		fail("INTEGRITY_FAILED");
	}
	return record;
}

export function validateResearchError(value: unknown): ResearchError {
	if (!isRecord(value)) fail("INTEGRITY_FAILED");
	exactKeys(value, ["error_code", "safe_message", "retryable", "request_id"]);
	if (typeof value.error_code !== "string" || !ERROR_CODES.has(value.error_code))
		fail("INTEGRITY_FAILED");
	if (value.safe_message !== SAFE_MESSAGES[value.error_code]) fail("INTEGRITY_FAILED");
	if (
		typeof value.retryable !== "boolean" ||
		!/^[0-9a-f]{32}$/.test(stringField(value.request_id))
	) {
		fail("INTEGRITY_FAILED");
	}
	return value as ResearchError;
}
