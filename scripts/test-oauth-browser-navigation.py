"""Historical CSP counterexample using real Chromium and synthetic loopback servers.

The actual Worker page is tested separately by test-oauth-runtime.py.
This is NOT ChatGPT or ChatGPT Automation acceptance. No production secrets are read.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

source = Path("src/oauth-entry.ts").read_text(encoding="utf-8")
original_policy = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
callback_hits = []
post_hits = []


class Callback(BaseHTTPRequestHandler):
    def do_GET(self):
        callback_hits.append({"method": "GET", "query_keys": sorted(parse_qs(urlsplit(self.path).query)), "body_length": 0})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<h1>Callback reached</h1>")

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(size)
        callback_hits.append({"method": "POST", "body_length": size})
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


class Authorization(BaseHTTPRequestHandler):
    policy = original_policy
    redirect_status = 302
    target = ""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Security-Policy", self.policy)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b'<form method="post" action="/authorize"><input name="owner_key" type="password" required><button type="submit">Authorize</button></form>')

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(size)
        post_hits.append({"status": self.redirect_status})
        self.send_response(self.redirect_status)
        self.send_header("Location", self.target + "?code=synthetic-code&state=synthetic-state")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, *args):
        pass


servers = []
results = []
try:
    for handler in [Callback, Authorization, Callback]:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    callback_url = f"http://127.0.0.1:{servers[0].server_port}/connector/oauth/test"
    auth_url = f"http://127.0.0.1:{servers[1].server_port}/authorize"
    unapproved_url = f"http://127.0.0.1:{servers[2].server_port}/unapproved"
    corrected_policy = original_policy.replace("form-action 'self'", "form-action 'self' " + callback_url)
    cases = [
        ("original-self-only-302", original_policy, 302, callback_url, False),
        ("303-alone-does-not-fix-CSP", original_policy, 303, callback_url, False),
        ("validated-callback-allowlist-302", corrected_policy, 302, callback_url, True),
        ("validated-callback-allowlist-303", corrected_policy, 303, callback_url, True),
        ("unapproved-origin-remains-blocked", corrected_policy, 303, unapproved_url, False),
    ]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        try:
            for name, policy, status, target, expected_callback in cases:
                Authorization.policy = policy
                Authorization.redirect_status = status
                Authorization.target = target
                callback_hits.clear()
                post_hits.clear()
                errors = []
                context = browser.new_context()
                try:
                    page = context.new_page()
                    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
                    page.goto(auth_url)
                    page.locator("input").fill("SYNTHETIC-NOT-A-REAL-SECRET")
                    page.get_by_role("button").click(no_wait_after=True)
                    page.wait_for_timeout(700)
                    result = {
                        "case": name,
                        "server_post_seen": len(post_hits),
                        "redirect_status": status,
                        "browser_callback_seen": len(callback_hits),
                        "callback_details": list(callback_hits),
                        "browser_stayed_on_authorization_page": page.url == auth_url,
                        "csp_form_action_violation": any("form-action" in error for error in errors),
                    }
                    results.append(result)
                    assert len(post_hits) == 1, result
                    assert bool(callback_hits) == expected_callback, result
                    if expected_callback:
                        assert callback_hits == [{"method": "GET", "query_keys": ["code", "state"], "body_length": 0}], result
                    else:
                        assert result["csp_form_action_violation"], result
                finally:
                    context.close()
        finally:
            browser.close()
finally:
    for server in servers:
        server.shutdown()
        server.server_close()

output = {
    "test_type": "real Chromium, isolated synthetic servers; NOT real ChatGPT acceptance",
    "browser_version": browser_version,
    "current_source_has_self_only_form_action": "form-action 'self';" in source,
    "results": results,
}
Path("oauth-browser-navigation-results.json").write_text(json.dumps(output, indent=2), encoding="utf-8")
print(json.dumps(output, indent=2))
