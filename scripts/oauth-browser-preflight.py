"""Credential-free Chromium regression for the consent redirect CSP boundary.

Three ephemeral loopback HTTP servers model the issuer, approved callback and
unapproved callback origins. No production URL, credential or session is used.
Actual server receipts, rather than Playwright request interception, prove whether
Chromium followed the post-consent redirect.
"""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src/oauth-entry.ts").read_text(encoding="utf-8")
MATCH = re.search(r'"Content-Security-Policy":\s*"([^"\n]+)"', SOURCE)
if not MATCH:
    raise RuntimeError("Authorization-page CSP not found: update this regression with the implementation")
CURRENT = MATCH.group(1)
if "form-action 'self' https://chatgpt.com" not in CURRENT:
    raise RuntimeError("Production CSP must use the exact minimal ChatGPT origin allowlist")
BASELINE = CURRENT.replace(" https://chatgpt.com", "")
STATE = {"policy": "", "callback": "", "with_iss": False, "events": []}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body=b"", headers=None):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def receipt(self, status, body_present=False):
        with LOCK:
            STATE["events"].append(
                {
                    "role": self.server.role,
                    "method": self.command,
                    "path": urlsplit(self.path).path,
                    "host": self.headers.get("Host"),
                    "status": status,
                    "body_present": body_present,
                }
            )

    def do_GET(self):
        if self.server.role == "issuer" and self.path == "/authorize":
            self.receipt(200)
            self.respond(
                200,
                b'<html><form method="POST" action="/authorize">'
                b'<input id="owner_key" name="owner_key" value="synthetic-fixture">'
                b'<button type="submit">Authorize</button></form></html>',
                {
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Security-Policy": STATE["policy"],
                    "Referrer-Policy": "no-referrer",
                },
            )
        elif self.server.role in ("allowed", "denied"):
            self.receipt(200, bool(self.headers.get("Content-Length", "0") != "0"))
            self.respond(200, b"<h1>Callback received</h1>", {"Content-Type": "text/html"})
        else:
            self.respond(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.server.role == "issuer" and self.path == "/authorize":
            self.receipt(302, bool(body))
            location = STATE["callback"] + "?code=synthetic-code&state=synthetic-state"
            if STATE["with_iss"]:
                location += "&iss=http%3A%2F%2Fissuer.test"
            self.respond(302, headers={"Location": location})
        else:
            self.receipt(400, bool(body))
            self.respond(400)


def server(role):
    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    instance.role = role
    threading.Thread(target=instance.serve_forever, daemon=True).start()
    return instance, f"http://127.0.0.1:{instance.server_port}"


def run_case(browser, name, policy, issuer, callback, expected, enter=False, with_iss=False):
    with LOCK:
        STATE.update(policy=policy, callback=callback, with_iss=with_iss, events=[])
    context = browser.new_context(service_workers="block")
    page = context.new_page()
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    failure = None
    try:
        page.goto(issuer + "/authorize")
        if enter:
            page.locator("#owner_key").press("Enter", no_wait_after=True)
        else:
            page.get_by_role("button").click(no_wait_after=True)
        for _ in range(20):
            page.wait_for_timeout(100)
            with LOCK:
                done = any(event["role"] != "issuer" for event in STATE["events"])
            if done or any("form-action" in error for error in errors):
                break
    except Exception as error:
        failure = type(error).__name__
    with LOCK:
        events = list(STATE["events"])
    received = [event for event in events if event["role"] != "issuer"]
    posted = any(event["role"] == "issuer" and event["status"] == 302 for event in events)
    csp_blocked = any("form-action" in error for error in errors)
    actual = bool(received)
    leaked_form = any(event["body_present"] or event["method"] != "GET" for event in received)
    passed = posted and actual == expected and not leaked_form and failure is None
    if not expected:
        passed = passed and csp_blocked
    result = {
        "case": name,
        "callback_received": actual,
        "expected_callback": expected,
        "server_returned_302": posted,
        "csp_form_action_blocked": csp_blocked,
        "callback_has_form_body": leaked_form,
        "driver_error": failure,
        "server_receipts": events,
        "result": "PASS" if passed else "FAIL",
    }
    context.close()
    return result


servers = []
try:
    issuer_server, issuer = server("issuer")
    allowed_server, allowed = server("allowed")
    denied_server, denied = server("denied")
    servers = [issuer_server, allowed_server, denied_server]
    candidate = BASELINE.replace("form-action 'self'", "form-action 'self' " + allowed)
    modern = allowed + "/connector/oauth/synthetic-test"
    legacy = allowed + "/connector_platform_oauth_redirect"
    lookalike = f"http://chatgpt.com.evil.test:{denied_server.server_port}/callback"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--host-resolver-rules=MAP chatgpt.com.evil.test 127.0.0.1"],
        )
        cases = [
            run_case(browser, "self_only_click_blocks_callback", BASELINE, issuer, modern, False),
            run_case(browser, "self_only_enter_blocks_callback", BASELINE, issuer, modern, False, enter=True),
            run_case(browser, "self_only_blocks_even_with_iss", BASELINE, issuer, modern, False, with_iss=True),
            run_case(browser, "candidate_modern_callback", candidate, issuer, modern, True),
            run_case(browser, "candidate_legacy_callback", candidate, issuer, legacy, True),
            run_case(browser, "candidate_callback_with_iss", candidate, issuer, modern, True, with_iss=True),
            run_case(browser, "candidate_enter_callback", candidate, issuer, modern, True, enter=True),
            run_case(browser, "candidate_unapproved_origin_denied", candidate, issuer, denied + "/callback", False),
            run_case(browser, "candidate_hostname_lookalike_denied", candidate, issuer, lookalike, False),
        ]
        report = {
            "kind": "SYNTHETIC_BROWSER_MECHANISM_TEST",
            "browser": browser.version,
            "network": "loopback HTTP only; separate issuer/callback origins",
            "production_csp": CURRENT,
            "real_chatgpt_acceptance": "NOT_RUN",
            "automation_acceptance": "NOT_RUN",
            "cases": cases,
        }
        browser.close()
    output = ROOT / "oauth-browser-preflight.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if any(case["result"] != "PASS" for case in cases):
        raise SystemExit(1)
finally:
    for instance in servers:
        instance.shutdown()
        instance.server_close()
