"""Offline browser mechanism test; NOT real ChatGPT or Automation acceptance.

All HTTP requests are intercepted with synthetic fixtures. No production requests,
credentials, browser profiles, authorization codes or tokens are used.
"""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src/oauth-entry.ts").read_text(encoding="utf-8")
MATCH = re.search(r'"Content-Security-Policy":\s*"([^"\n]+)"', SOURCE)
if not MATCH:
    raise RuntimeError("Authorization-page CSP not found: update this test with the implementation")
CURRENT = MATCH.group(1)
BASELINE = CURRENT.replace(" https://chatgpt.com", "")
CANDIDATE = BASELINE.replace("form-action 'self'", "form-action 'self' https://chatgpt.com")
ISSUER = "https://collector.test"


def run_case(browser, name, policy, callback, expected, enter=False, with_iss=False):
    context = browser.new_context()
    page = context.new_page()
    requests = []
    errors = []

    def route_request(route):
        request = route.request
        url = urlsplit(request.url)
        requests.append({"origin": url.netloc, "path": url.path,
                         "method": request.method, "body_present": bool(request.post_data)})
        if request.url == ISSUER + "/authorize" and request.method == "GET":
            route.fulfill(status=200, headers={
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": policy,
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
            }, body='<html><form method="POST" action="/authorize">'
                    '<input id="owner_key" name="owner_key" value="synthetic-fixture">'
                    '<button type="submit">Authorize</button></form></html>')
        elif request.url == ISSUER + "/authorize" and request.method == "POST":
            location = callback + "?code=synthetic-code&state=synthetic-state"
            if with_iss:
                location += "&iss=https%3A%2F%2Fcollector.test"
            route.fulfill(status=302, headers={"Location": location,
                                               "Cache-Control": "no-store"}, body="")
        else:
            route.fulfill(status=200, content_type="text/html", body="<h1>Callback received</h1>")

    page.route("**/*", route_request)
    page.on("console", lambda message: errors.append(message.text)
            if message.type == "error" else None)
    page.goto(ISSUER + "/authorize")
    if enter:
        page.locator("#owner_key").press("Enter", no_wait_after=True)
    else:
        page.get_by_role("button").click(no_wait_after=True)
    page.wait_for_timeout(1000)
    received = [r for r in requests if r["origin"] == urlsplit(callback).netloc
                and r["path"] == urlsplit(callback).path]
    csp_blocked = any("form-action" in error for error in errors)
    actual = bool(received)
    assert any(r["method"] == "POST" and r["path"] == "/authorize" for r in requests), name
    assert actual == expected, f"{name}: callback_received={actual}, expected={expected}"
    if not expected:
        assert csp_blocked, f"{name}: failure was not a CSP block"
    for request in received:
        assert request["method"] == "GET" and not request["body_present"], name
    result = {"case": name, "callback_received": actual,
              "server_returned_302": True, "csp_form_action_blocked": csp_blocked,
              "callback_has_form_body": any(r["body_present"] for r in received),
              "result": "PASS"}
    context.close()
    return result


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    modern = "https://chatgpt.com/connector/oauth/synthetic-test"
    legacy = "https://chatgpt.com/connector_platform_oauth_redirect"
    cases = [
        run_case(browser, "self_only_click_blocks_callback", BASELINE, modern, False),
        run_case(browser, "self_only_enter_blocks_callback", BASELINE, modern, False, enter=True),
        run_case(browser, "self_only_blocks_even_with_iss", BASELINE, modern, False, with_iss=True),
        run_case(browser, "candidate_modern_callback", CANDIDATE, modern, True),
        run_case(browser, "candidate_legacy_callback", CANDIDATE, legacy, True),
        run_case(browser, "candidate_callback_with_iss", CANDIDATE, modern, True, with_iss=True),
        run_case(browser, "candidate_unapproved_origin_denied", CANDIDATE,
                 "https://unapproved.test/callback", False),
        run_case(browser, "candidate_lookalike_origin_denied", CANDIDATE,
                 "https://chatgpt.com.unapproved.test/callback", False),
    ]
    report = {"kind": "SYNTHETIC_BROWSER_MECHANISM_TEST",
              "browser": browser.version,
              "current_source_allows_chatgpt": "https://chatgpt.com" in CURRENT,
              "real_chatgpt_acceptance": "NOT_RUN",
              "automation_acceptance": "NOT_RUN", "cases": cases}
    browser.close()

output = ROOT / "oauth-browser-preflight.json"
output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
