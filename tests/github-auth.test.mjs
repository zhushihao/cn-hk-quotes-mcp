import assert from "node:assert/strict";
import test from "node:test";

import {
	EXPECTED_GITHUB_LOGIN,
	EXPECTED_PRIVATE_REPO,
	verifyGithubAccessToken,
} from "../src/github-auth.ts";

function fakeFetch({ login = EXPECTED_GITHUB_LOGIN, push = true, privateRepo = true } = {}) {
	return async (url) => {
		if (url === "https://api.github.com/user") {
			return new Response(JSON.stringify({ login }), { status: 200 });
		}
		if (url === `https://api.github.com/repos/${EXPECTED_PRIVATE_REPO}`) {
			return new Response(JSON.stringify({
				full_name: EXPECTED_PRIVATE_REPO,
				private: privateRepo,
				permissions: { push },
			}), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	};
}

test("accepts existing GitHub identity with write access to private quantpro-qmt", async () => {
	await assert.doesNotReject(() => verifyGithubAccessToken("token", { fetchImpl: fakeFetch() }));
});

test("rejects a different GitHub login", async () => {
	await assert.rejects(
		() => verifyGithubAccessToken("token", { fetchImpl: fakeFetch({ login: "someone-else" }) }),
		/login mismatch/i,
	);
});

test("rejects token without private repo write permission", async () => {
	await assert.rejects(
		() => verifyGithubAccessToken("token", { fetchImpl: fakeFetch({ push: false }) }),
		/write permission/i,
	);
});

test("rejects a repository that is not private", async () => {
	await assert.rejects(
		() => verifyGithubAccessToken("token", { fetchImpl: fakeFetch({ privateRepo: false }) }),
		/private repository mismatch/i,
	);
});
