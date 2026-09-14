"""Run the actual Worker locally with an isolated D1/KV/R2 and synthetic identities.

No Cloudflare account, real owner key, LIVE records or ChatGPT credentials are used.
A real Chromium follows the actual consent page; only the final ChatGPT callback is
intercepted with a synthetic receiver. This is NOT real ChatGPT/Automation acceptance.
Only named assertions and boolean evidence are printed or saved as artifacts.
"""
import base64
import hashlib
import html
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RESOURCE = "https://cn-hk-quotes-mcp.zhushihao710.workers.dev/mcp"
CALLBACK = "https://chatgpt.com/connector/oauth/quantpro-isolated-e2e"
BASE = "http://127.0.0.1:18787"
OWNER = secrets.token_hex(32)
INTERNAL = secrets.token_hex(32)
INGEST = secrets.token_hex(32)
REPORT = {"test_type": "isolated real Workerd + real D1 + real Chromium; synthetic callback; NOT ChatGPT acceptance", "checks": []}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect())


def check(name, passed, **safe_details):
    result = {"check": name, "pass": bool(passed), **safe_details}
    REPORT["checks"].append(result)
    print(json.dumps(result), flush=True)
    if not passed:
        raise AssertionError(name)


def http(path, *, method="GET", payload=None, form=None, bearer=None, headers=None):
    if not path.startswith("/"):
        raise AssertionError("All non-browser HTTP calls must stay on the isolated local Worker")
    actual_headers = {"Accept": "application/json", **(headers or {})}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        actual_headers["Content-Type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        actual_headers["Content-Type"] = "application/x-www-form-urlencoded"
    if bearer is not None:
        actual_headers["Authorization"] = "Bearer " + bearer
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=actual_headers)
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(1024 * 1024).decode("utf-8", errors="replace")
        return response.status, response.headers, raw


def register(auth_method):
    status, _, raw = http("/oauth/register", method="POST", payload={
        "client_name": "QuantPro isolated test " + auth_method,
        "redirect_uris": [CALLBACK],
        "token_endpoint_auth_method": auth_method,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    })
    body = json.loads(raw)
    check("DCR_" + auth_method, status == 201 and bool(body.get("client_id")), http_status=status)
    return body


def authorization(client, **overrides):
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(24)
    parameters = {
        "response_type": "code", "client_id": client["client_id"],
        "redirect_uri": CALLBACK, "scope": "market:read offline_access",
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "resource": RESOURCE,
        **overrides,
    }
    return "/authorize?" + urllib.parse.urlencode(parameters), verifier, state


def form_state(path):
    status, headers, raw = http(path)
    check("consent_get", status == 200 and OWNER not in raw, http_status=status)
    policy = headers.get("Content-Security-Policy", "")
    check("actual_page_CSP_allows_only_validated_callback_origin", "form-action 'self' https://chatgpt.com;" in policy and "*" not in policy)
    match = re.search(r'name="csrf" value="([^"]+)"', raw)
    check("signed_form_state_present", bool(match))
    return html.unescape(match.group(1))


def submit_code(path, state):
    csrf = form_state(path)
    status, headers, raw = http(path, method="POST", form={"csrf": csrf, "owner_key": OWNER})
    location = headers.get("Location", "")
    parsed = urllib.parse.urlsplit(location)
    parameters = urllib.parse.parse_qs(parsed.query)
    check("consent_POST_303", status == 303 and parsed.scheme == "https" and parsed.netloc == "chatgpt.com", http_status=status)
    check("callback_state_preserved_no_long_lived_secret", parameters.get("state") == [state] and OWNER not in location and OWNER not in raw and bool(parameters.get("code")))
    return parameters["code"][0]


def token(client, form):
    auth_method = client["token_endpoint_auth_method"]
    form = {"client_id": client["client_id"], **form}
    headers = {}
    if auth_method == "client_secret_basic":
        pair = urllib.parse.quote(client["client_id"], safe="") + ":" + urllib.parse.quote(client["client_secret"], safe="")
        headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
    elif auth_method == "client_secret_post":
        form["client_secret"] = client["client_secret"]
    status, response_headers, raw = http("/oauth/token", method="POST", form=form, headers=headers)
    body = json.loads(raw) if raw else {}
    return status, response_headers, body


def exchange(client, code, verifier, **overrides):
    return token(client, {
        "grant_type": "authorization_code", "code": code, "code_verifier": verifier,
        "redirect_uri": CALLBACK, "resource": RESOURCE, **overrides,
    })


def mcp(method, params=None, bearer=None):
    status, headers, raw = http("/mcp", method="POST", bearer=bearer, headers={
        "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26",
    }, payload={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
    if headers.get("Content-Type", "").startswith("text/event-stream"):
        messages = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: ")]
        body = next((item for item in reversed(messages) if item.get("id") == 1), {})
    else:
        body = json.loads(raw) if raw else {}
    return status, headers, body


def initialize(bearer=None):
    return mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "quantpro-isolated-e2e", "version": "1"}}, bearer)


def control(bearer=None):
    status, headers, body = mcp("tools/call", {"name": "get_control_plane_status", "arguments": {}}, bearer)
    content = body.get("result", {}).get("content", [])
    value = json.loads(content[0]["text"]) if content else {}
    return status, value


def browser_consent(browser, client):
    path, verifier, state = authorization(client)
    context = browser.new_context()
    callbacks = []
    page_errors = []
    try:
        def route_request(route):
            parsed = urllib.parse.urlsplit(route.request.url)
            if parsed.scheme == "https" and parsed.netloc == "chatgpt.com" and parsed.path == "/connector/oauth/quantpro-isolated-e2e":
                callbacks.append({"method": route.request.method, "body": route.request.post_data, "query": urllib.parse.parse_qs(parsed.query)})
                route.fulfill(status=200, content_type="text/html", body="<h1>Synthetic callback reached</h1>")
            elif parsed.scheme == "http" and parsed.netloc == "127.0.0.1:18787":
                route.continue_()
            else:
                route.abort()
        context.route("**/*", route_request)
        page = context.new_page()
        page.on("console", lambda message: page_errors.append(message.text) if message.type == "error" else None)
        response = page.goto(BASE + path)
        check("browser_actual_consent_page_200", response.status == 200)
        page.locator("#owner_key").fill(OWNER)
        with page.expect_request(lambda request: request.url.startswith(CALLBACK + "?"), timeout=10000):
            page.get_by_role("button", name="授权只读访问").click(no_wait_after=True)
        page.wait_for_timeout(250)
        check("browser_callback_really_reached", len(callbacks) == 1)
        callback = callbacks[0]
        check("browser_callback_GET_without_owner_body", callback["method"] == "GET" and callback["body"] is None)
        check("browser_callback_state_and_code", callback["query"].get("state") == [state] and bool(callback["query"].get("code")))
        check("browser_no_form_action_violation", not any("form-action" in message for message in page_errors))
        return callback["query"]["code"][0], verifier
    finally:
        context.close()


def run_checks():
    status, _, metadata_raw = http("/.well-known/oauth-authorization-server")
    metadata = json.loads(metadata_raw)
    check("real_Worker_discovery", status == 200 and "S256" in metadata.get("code_challenge_methods_supported", []))
    status, _, _ = initialize()
    check("anonymous_MCP_initialize_still_works", status == 200, http_status=status)
    status, value = control()
    check("anonymous_MCP_stays_SKIPPED_UNAUTHORIZED", status == 200 and value.get("live_overlay_status") == "SKIPPED_UNAUTHORIZED", http_status=status)
    for label, credential in [("invalid", "invalid"), ("owner_not_access_token", OWNER), ("internal_not_access_token", INTERNAL), ("research_ingest_not_access_token", INGEST)]:
        status, headers, _ = initialize(credential)
        challenge = headers.get("WWW-Authenticate", "")
        check("reject_" + label, status == 401 and 'Bearer resource_metadata="' in challenge and ', scope="market:read", error="invalid_token"' in challenge, http_status=status)
    public_client = register("none")
    for label, changes in [
        ("unregistered_callback", {"redirect_uri": "https://not-approved.example/callback"}),
        ("wrong_resource", {"resource": "https://wrong-audience.example/mcp"}),
        ("privileged_scope", {"scope": "market:read research:read trade:write"}),
        ("plain_PKCE", {"code_challenge_method": "plain"}),
    ]:
        path, _, _ = authorization(public_client, **changes)
        status, _, _ = http(path)
        check("reject_" + label, status == 400, http_status=status)
    path, _, _ = authorization(public_client)
    csrf = form_state(path)
    status, _, raw = http(path, method="POST", form={"csrf": csrf, "owner_key": "wrong-owner"})
    check("wrong_owner_is_401_not_callback", status == 401 and "授权密钥不匹配" in raw, http_status=status)
    status, _, raw = http(path, method="POST", form={"csrf": "tampered", "owner_key": OWNER})
    check("tampered_form_state_is_400", status == 400 and "授权会话已过期或无效" in raw, http_status=status)
    altered_path, _, _ = authorization(public_client)
    status, _, _ = http(altered_path, method="POST", form={"csrf": csrf, "owner_key": OWNER})
    check("signed_state_bound_to_exact_authorization_request", status == 400, http_status=status)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        REPORT["browser_version"] = browser.version
        try:
            for auth_method in ["none", "client_secret_post", "client_secret_basic"]:
                client = public_client if auth_method == "none" else register(auth_method)
                code, verifier = browser_consent(browser, client)
                status, headers, tokens = exchange(client, code, verifier)
                check("code_exchange_" + auth_method, status == 200 and bool(tokens.get("access_token")) and bool(tokens.get("refresh_token")), http_status=status)
                check("token_response_no_store_" + auth_method, "no-store" in headers.get("Cache-Control", ""))
                check("token_scope_and_lifetime_" + auth_method, set(tokens.get("scope", "").split()) == {"market:read", "offline_access"} and tokens.get("expires_in") == 3600)
                access = tokens["access_token"]
                status, _, _ = initialize(access)
                check("authenticated_MCP_initialize_" + auth_method, status == 200, http_status=status)
                status, value = control(access)
                check("real_OAuth_token_unlocks_market_read_" + auth_method, status == 200 and value.get("live_overlay_status") == "ENABLED" and value.get("market_read_auth", {}).get("authenticated") is True, http_status=status)
                status, _, _ = exchange(client, code, verifier)
                check("code_replay_rejected_" + auth_method, status == 400, http_status=status)
                status, _, _ = token(client, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "resource": "https://wrong-audience.example/mcp"})
                check("refresh_wrong_audience_rejected_" + auth_method, status == 400, http_status=status)
                status, _, refreshed = token(client, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "resource": RESOURCE})
                check("refresh_exchange_" + auth_method, status == 200 and bool(refreshed.get("access_token")) and bool(refreshed.get("refresh_token")), http_status=status)
                check("refresh_rotates_both_tokens_" + auth_method, refreshed["access_token"] != access and refreshed["refresh_token"] != tokens["refresh_token"])
                status, value = control(refreshed["access_token"])
                check("refreshed_token_unlocks_market_read_" + auth_method, status == 200 and value.get("live_overlay_status") == "ENABLED", http_status=status)
                status, _, downscoped = token(client, {"grant_type": "refresh_token", "refresh_token": refreshed["refresh_token"], "scope": "offline_access"})
                check("refresh_downscope_" + auth_method, status == 200 and downscoped.get("scope") == "offline_access", http_status=status)
                status, _, _ = initialize(downscoped["access_token"])
                check("token_without_market_scope_denied_" + auth_method, status == 403, http_status=status)
                # The library implements RFC 7009 at the advertised revocation endpoint.
                revocation_url = metadata.get("revocation_endpoint", "")
                revocation_path = urllib.parse.urlsplit(revocation_url).path
                check("revocation_endpoint_advertised", bool(revocation_path))
                auth_headers = {}
                revocation_form = {"client_id": client["client_id"], "token": downscoped.get("refresh_token", refreshed["refresh_token"]), "token_type_hint": "refresh_token"}
                if auth_method == "client_secret_basic":
                    pair = client["client_id"] + ":" + client["client_secret"]
                    auth_headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
                elif auth_method == "client_secret_post":
                    revocation_form["client_secret"] = client["client_secret"]
                status, _, _ = http(revocation_path, method="POST", form=revocation_form, headers=auth_headers)
                check("grant_revocation_" + auth_method, status == 200, http_status=status)
                status, _, _ = initialize(refreshed["access_token"])
                check("revoked_access_token_denied_" + auth_method, status == 401, http_status=status)
                status, _, _ = token(client, {"grant_type": "refresh_token", "refresh_token": revocation_form["token"]})
                check("revoked_refresh_denied_" + auth_method, status == 400, http_status=status)
            client = register("none")
            path, verifier, state = authorization(client)
            code = submit_code(path, state)
            status, _, _ = exchange(client, code, secrets.token_urlsafe(48))
            check("wrong_PKCE_verifier_rejected", status == 400, http_status=status)
        finally:
            browser.close()


process = None
try:
    with tempfile.TemporaryDirectory(prefix=".oauth-e2e-", dir=ROOT) as directory:
        directory = Path(directory)
        config = {
            "name": "quantpro-isolated-oauth-test", "main": str(ROOT / "src/oauth-diagnostics-entry.ts"),
            "compatibility_date": "2026-07-02", "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
            "vars": {"COLLECTOR_MCP_CLIENT_TOKEN": OWNER, "COLLECTOR_MCP_CLIENT_ID": "chatgpt-production", "COLLECTOR_MCP_CLIENT_SCOPES": "market:read", "PORTFOLIO_UNIVERSE_TOKEN": INTERNAL, "RESEARCH_REPLICA_INGEST_TOKEN": INGEST, "GITHUB_TOKEN": ""},
            "kv_namespaces": [{"binding": "PORTFOLIO_UNIVERSE", "id": "00000000000000000000000000000001"}],
            "d1_databases": [{"binding": "RESEARCH_REPLICA", "database_name": "isolated-oauth", "database_id": "00000000-0000-0000-0000-000000000001"}],
            "r2_buckets": [{"binding": "RESEARCH_OBJECTS", "bucket_name": "isolated-oauth-objects"}],
            "observability": {"enabled": False},
        }
        config_path = directory / "wrangler.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        child_env = dict(os.environ)
        for name in list(child_env):
            if name.startswith(("CLOUDFLARE_", "CF_ACCESS_", "COLLECTOR_", "PORTFOLIO_", "RESEARCH_REPLICA_INGEST")):
                del child_env[name]
        child_env["WRANGLER_SEND_METRICS"] = "false"
        log_path = directory / "worker.log"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen([str(ROOT / "node_modules/.bin/wrangler"), "dev", "--local", "--config", str(config_path), "--ip", "127.0.0.1", "--port", "18787", "--inspector-port", "0", "--persist-to", str(directory / "state")], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=child_env)
            try:
                ready = False
                for _ in range(60):
                    if process.poll() is not None:
                        break
                    try:
                        status, _, _ = http("/.well-known/oauth-authorization-server")
                        if status == 200:
                            ready = True
                            break
                    except (urllib.error.URLError, TimeoutError, OSError):
                        pass
                    time.sleep(1)
                if not ready:
                    text = log_path.read_text(encoding="utf-8")
                    safe_errors = [line for line in text.splitlines() if "ERROR" in line or "Could not resolve" in line or "Cannot find" in line]
                    for line in safe_errors[:12]:
                        for value in [OWNER, INTERNAL, INGEST]:
                            line = line.replace(value, "[REDACTED]")
                        print(line)
                check("isolated_worker_ready", ready)
                run_checks()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process = None
finally:
    if process is not None:
        process.kill()
    REPORT["all_pass"] = bool(REPORT["checks"]) and all(item["pass"] for item in REPORT["checks"])
    (ROOT / "oauth-runtime-results.json").write_text(json.dumps(REPORT, indent=2), encoding="utf-8")
