export const EXPECTED_GITHUB_LOGIN = "zhushihao";
export const EXPECTED_PRIVATE_REPO = "zhushihao/quantpro-qmt";
const GITHUB_API_VERSION = "2022-11-28";

type GithubUser = {
	login?: unknown;
};

type GithubRepo = {
	full_name?: unknown;
	private?: unknown;
	permissions?: {
		admin?: unknown;
		maintain?: unknown;
		push?: unknown;
	};
};

export class GithubAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GithubAuthError";
	}
}

function headers(token: string): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "cn-hk-quotes-mcp/portfolio-control",
	};
}

async function fetchGithubJson<T>(
	url: string,
	token: string,
	fetchImpl: typeof fetch,
): Promise<T> {
	let response: Response;
	try {
		response = await fetchImpl(url, { headers: headers(token) });
	} catch {
		throw new GithubAuthError("GitHub identity verification request failed");
	}
	if (!response.ok) {
		throw new GithubAuthError(`GitHub identity verification failed with HTTP ${response.status}`);
	}
	return await response.json() as T;
}

export async function verifyGithubAccessToken(
	token: string,
	options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
	if (!token) throw new GithubAuthError("GitHub bearer token is required");
	const fetchImpl = options.fetchImpl ?? fetch;
	const user = await fetchGithubJson<GithubUser>("https://api.github.com/user", token, fetchImpl);
	if (user.login !== EXPECTED_GITHUB_LOGIN) {
		throw new GithubAuthError("GitHub login mismatch");
	}
	const repo = await fetchGithubJson<GithubRepo>(
		`https://api.github.com/repos/${EXPECTED_PRIVATE_REPO}`,
		token,
		fetchImpl,
	);
	if (repo.full_name !== EXPECTED_PRIVATE_REPO || repo.private !== true) {
		throw new GithubAuthError("GitHub private repository mismatch");
	}
	const permissions = repo.permissions ?? {};
	if (permissions.push !== true && permissions.admin !== true && permissions.maintain !== true) {
		throw new GithubAuthError("GitHub token lacks write permission on private repository");
	}
}

export function githubBearerToken(request: Request): string {
	const authorization = request.headers.get("Authorization") ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match) throw new GithubAuthError("GitHub bearer token is required");
	return match[1];
}
