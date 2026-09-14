const OAUTH_TABLE = "oauth_kv_v1";
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 1000;

let schemaReady: Promise<void> | null = null;

type StoredRow = {
	value: string;
	expires_at: number | null;
};

type ListedRow = {
	kv_key: string;
	expires_at: number | null;
};

type KvReadType = "text" | "json" | "arrayBuffer" | "stream";

type KvGetOptions = {
	type?: KvReadType;
	cacheTtl?: number;
};

type KvPutOptions = {
	expiration?: number;
	expirationTtl?: number;
	metadata?: unknown;
};

type KvListOptions = {
	prefix?: string;
	limit?: number;
	cursor?: string;
};

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

async function ensureSchema(db: D1Database): Promise<void> {
	if (!schemaReady) {
		schemaReady = db
			.prepare(
				`CREATE TABLE IF NOT EXISTS ${OAUTH_TABLE} (
					kv_key TEXT PRIMARY KEY NOT NULL,
					value TEXT NOT NULL,
					expires_at INTEGER
				) WITHOUT ROWID`,
			)
			.run()
			.then(() => undefined)
			.catch((error) => {
				schemaReady = null;
				throw error;
			});
	}
	await schemaReady;
}

function normalizeReadType(options?: KvReadType | KvGetOptions): KvReadType {
	if (typeof options === "string") return options;
	return options?.type ?? "text";
}

function expirationFromOptions(options?: KvPutOptions): number | null {
	if (typeof options?.expiration === "number") return Math.floor(options.expiration);
	if (typeof options?.expirationTtl === "number") {
		return nowSeconds() + Math.floor(options.expirationTtl);
	}
	return null;
}

function cursorOffset(cursor?: string): number {
	if (!cursor) return 0;
	const parsed = Number.parseInt(cursor, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function listLimit(limit?: number): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit!)));
}

function prefixUpperBound(prefix: string): string {
	return `${prefix}\uffff`;
}

function textToArrayBuffer(value: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(value);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * `workers-oauth-provider` currently persists through the Workers KV interface. The account's
 * free-tier KV writes are also used by the LIVE control plane and can exhaust the account-wide
 * 1,000 writes/day quota. This adapter gives OAuth an isolated SQL table in the already-private
 * Collector D1 database while preserving the narrow KV surface the provider actually uses.
 */
export function createD1OAuthKv(db: D1Database): KVNamespace {
	const adapter = {
		async get(key: string, options?: KvReadType | KvGetOptions): Promise<unknown> {
			await ensureSchema(db);
			const row = await db
				.prepare(`SELECT value, expires_at FROM ${OAUTH_TABLE} WHERE kv_key = ?1`)
				.bind(key)
				.first<StoredRow>();
			if (!row) return null;
			if (row.expires_at !== null && row.expires_at <= nowSeconds()) return null;

			const type = normalizeReadType(options);
			if (type === "json") return JSON.parse(row.value) as unknown;
			if (type === "arrayBuffer") return textToArrayBuffer(row.value);
			if (type === "stream") {
				return new Blob([row.value]).stream();
			}
			return row.value;
		},

		async getWithMetadata(key: string, options?: KvReadType | KvGetOptions): Promise<unknown> {
			const value = await adapter.get(key, options);
			return { value, metadata: null, cacheStatus: null };
		},

		async put(key: string, value: string, options?: KvPutOptions): Promise<void> {
			if (typeof value !== "string") {
				throw new TypeError("OAuth D1 storage only accepts string values");
			}
			await ensureSchema(db);
			const expiresAt = expirationFromOptions(options);
			await db
				.prepare(
					`INSERT INTO ${OAUTH_TABLE} (kv_key, value, expires_at)
					 VALUES (?1, ?2, ?3)
					 ON CONFLICT(kv_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
				)
				.bind(key, value, expiresAt)
				.run();
		},

		async delete(key: string): Promise<void> {
			await ensureSchema(db);
			await db.prepare(`DELETE FROM ${OAUTH_TABLE} WHERE kv_key = ?1`).bind(key).run();
		},

		async list(options: KvListOptions = {}): Promise<unknown> {
			await ensureSchema(db);
			const prefix = options.prefix ?? "";
			const limit = listLimit(options.limit);
			const offset = cursorOffset(options.cursor);
			const rows = await db
				.prepare(
					`SELECT kv_key, expires_at
					 FROM ${OAUTH_TABLE}
					 WHERE kv_key >= ?1 AND kv_key < ?2
					   AND (expires_at IS NULL OR expires_at > ?3)
					 ORDER BY kv_key
					 LIMIT ?4 OFFSET ?5`,
				)
				.bind(prefix, prefixUpperBound(prefix), nowSeconds(), limit + 1, offset)
				.all<ListedRow>();
			const visible = rows.results.slice(0, limit);
			const listComplete = rows.results.length <= limit;
			return {
				keys: visible.map((row) => ({
					name: row.kv_key,
					...(row.expires_at === null ? {} : { expiration: row.expires_at }),
				})),
				list_complete: listComplete,
				cursor: listComplete ? undefined : String(offset + limit),
				cacheStatus: null,
			};
		},
	};

	return adapter as unknown as KVNamespace;
}
