import {
	assertLiveUniverseFresh,
	readLiveUniverse,
	validateLiveUniverse,
	writeLiveUniverse,
	type StoredLiveUniverse,
} from "./live-universe.ts";

export const CONTROL_REPOSITORY = "zhushihao/QuantPro";
export const CONTROL_REF = "portfolio-runtime";
export const CONTROL_UNIVERSE_PATH = "portfolio/quote-universe.json";
export const CONTROL_PROBE_PATH = "control-plane/probe.json";

export type ControlPlaneEnv = {
	GITHUB_TOKEN: string;
	PORTFOLIO_UNIVERSE?: KVNamespace;
};

export type ControlPlaneSyncResult = {
	status: "SYNCED" | "NO_CHANGE" | "NO_UNIVERSE";
	universe: StoredLiveUniverse | null;
};

export class ControlPlaneError extends Error {
	readonly httpStatus: number | null;

	constructor(message: string, httpStatus: number | null = null) {
		super(message);
		this.name = "ControlPlaneError";
		this.httpStatus = httpStatus;
	}
}

function rawGithubHeaders(token: string): HeadersInit {
	return {
		Accept: "application/vnd.github.raw+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "cn-hk-quotes-private-control/1.0",
	};
}

export async function fetchPrivateControlFile(
	env: ControlPlaneEnv,
	path: string,
): Promise<string | null> {
	if (!env.GITHUB_TOKEN) throw new ControlPlaneError("GITHUB_TOKEN is not configured");
	const url = new URL(`https://api.github.com/repos/${CONTROL_REPOSITORY}/contents/${path}`);
	url.searchParams.set("ref", CONTROL_REF);
	let response: Response;
	try {
		response = await fetch(url, { headers: rawGithubHeaders(env.GITHUB_TOKEN) });
	} catch (error) {
		throw new ControlPlaneError(`private GitHub fetch failed: ${error instanceof Error ? error.name : typeof error}`);
	}
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new ControlPlaneError(`private GitHub fetch failed with HTTP ${response.status}`, response.status);
	}
	return response.text();
}

export async function probePrivateControlPlane(env: ControlPlaneEnv): Promise<boolean> {
	const raw = await fetchPrivateControlFile(env, CONTROL_PROBE_PATH);
	if (!raw) return false;
	try {
		const parsed = JSON.parse(raw) as { schema?: unknown };
		return parsed.schema === "quantpro-control-probe/1";
	} catch {
		return false;
	}
}

export async function syncLiveUniverseFromPrivateGithub(
	env: ControlPlaneEnv,
): Promise<ControlPlaneSyncResult> {
	if (!env.PORTFOLIO_UNIVERSE) throw new ControlPlaneError("PORTFOLIO_UNIVERSE KV is not configured");
	const raw = await fetchPrivateControlFile(env, CONTROL_UNIVERSE_PATH);
	if (!raw) {
		return { status: "NO_UNIVERSE", universe: await readLiveUniverse(env.PORTFOLIO_UNIVERSE) };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new ControlPlaneError("private quote universe is invalid JSON");
	}
	const validated = await validateLiveUniverse(payload);
	const candidate: StoredLiveUniverse = {
		...validated,
		received_at: new Date().toISOString(),
	};
	assertLiveUniverseFresh(candidate);
	const current = await readLiveUniverse(env.PORTFOLIO_UNIVERSE);
	if (current?.content_hash === candidate.content_hash) {
		return { status: "NO_CHANGE", universe: current };
	}
	const stored = await writeLiveUniverse(env.PORTFOLIO_UNIVERSE, validated, candidate.received_at);
	return { status: "SYNCED", universe: stored };
}
