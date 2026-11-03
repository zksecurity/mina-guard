"""Offline and local HTTP checks for the mainnet served-content monitor."""

import importlib.util
import gzip
import json
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "mainnet-content-integrity.py"
spec = importlib.util.spec_from_file_location("mainnet_content_integrity", SCRIPT)
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)

DIGEST = "sha256:" + "a" * 64
SOURCE_SHA = "b" * 40
UI_POLICY_MODULE = Path(__file__).resolve().parents[2] / "ui" / "content-security-policy.mjs"

# Headers the live mainnet site sends on HTML pages once the app sets the
# policy and the gateway adds frame and HSTS headers.
GOOD_PAGE_HEADERS = {
    "Content-Security-Policy": integrity.EXPECTED_CONTENT_SECURITY_POLICY,
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
}


def fixture(next_root: Path) -> dict[str, bytes]:
    """Build a small Next-shaped filesystem and corresponding public bodies."""
    bodies = {}
    for route in integrity.DEFAULT_ROUTES:
        html = (b"<html><script src='/_next/static/chunks/app.js'></script>"
                b"<script>self.__next_f.push([1,'approved'])</script></html>")
        path = next_root / "server" / "app" / (
            "index.html" if route == "/" else f"{route[1:]}.html"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(html)
        bodies[route] = html
    for name, data in {
        "chunks/app.js": b"console.log('approved');",
        "chunks/worker.js": b"postMessage('approved');",
        "css/app.css": b"body{color:black}",
    }.items():
        path = next_root / "static" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        bodies[f"/_next/static/{name}"] = data
    return bodies


class ContentServer:
    def __init__(self, bodies: dict[str, bytes]):
        self.bodies = bodies
        self.redirects = {}
        self.gzip_paths = set()
        self.user_agents = []
        self.legacy_checker_bodies = {}
        # Header name -> list of values sent on HTML route responses. Static
        # assets get none, which the checker must accept.
        self.page_headers = {name: [value] for name, value in GOOD_PAGE_HEADERS.items()}

        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                user_agent = self.headers.get("User-Agent", "")
                owner.user_agents.append(user_agent)
                if self.path in owner.redirects:
                    self.send_response(302)
                    self.send_header("Location", owner.redirects[self.path])
                    self.end_headers()
                    return
                data = owner.bodies.get(self.path)
                if user_agent == "MinaGuard-content-integrity/1":
                    data = owner.legacy_checker_bodies.get(self.path, data)
                if data is None:
                    self.send_error(404)
                    return
                if self.path in owner.gzip_paths:
                    data = gzip.compress(data)
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                if self.path in integrity.DEFAULT_ROUTES:
                    for name, values in owner.page_headers.items():
                        for value in values:
                            self.send_header(name, value)
                if self.path in owner.gzip_paths:
                    self.send_header("Content-Encoding", "gzip")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"


class ContentIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.next_root = Path(self.temp.name) / ".next"
        self.bodies = fixture(self.next_root)
        self.manifest = integrity.make_baseline(self.next_root, DIGEST, SOURCE_SHA)

    def check(self, server):
        return integrity.check_public(
            self.manifest, server.url, allow_http_for_tests=True
        )

    def test_approved_image_matches_public_content(self):
        with ContentServer(self.bodies) as server:
            self.assertEqual(self.check(server), [])
        self.assertIn("/_next/static/chunks/worker.js", self.manifest["assets"])
        self.assertEqual(set(self.manifest["routes"]), set(integrity.DEFAULT_ROUTES))

    def test_baseline_cli_round_trip(self):
        path = Path(self.temp.name) / "mainnet-content.json"
        self.assertEqual(integrity.main([
            "baseline", "--next-root", str(self.next_root),
            "--frontend-digest", DIGEST, "--source-sha", SOURCE_SHA,
            "--output", str(path),
        ]), 0)
        self.assertEqual(integrity.load_manifest(path), self.manifest)

    def test_injected_inline_script_changes_html_hash(self):
        with ContentServer(self.bodies.copy()) as server:
            server.bodies["/transactions/new"] += b"<script>stealFunds()</script>"
            self.assertIn("/transactions/new: content hash mismatch", self.check(server))

    def test_injected_external_script_changes_html_hash(self):
        with ContentServer(self.bodies.copy()) as server:
            server.bodies["/"] += b"<script src='https://evil.example/steal.js'></script>"
            self.assertIn("/: content hash mismatch", self.check(server))

    def test_modified_worker_asset_is_detected(self):
        with ContentServer(self.bodies.copy()) as server:
            server.bodies["/_next/static/chunks/worker.js"] = b"postMessage('evil');"
            self.assertIn("/_next/static/chunks/worker.js: content hash mismatch", self.check(server))

    def test_checker_does_not_announce_itself_in_requests(self):
        with ContentServer(self.bodies.copy()) as server:
            self.assertEqual(self.check(server), [])
            self.assertEqual(len(server.user_agents), len(self.manifest["routes"]) + len(self.manifest["assets"]))
            for user_agent in server.user_agents:
                self.assertTrue(user_agent.startswith("Mozilla/5.0 "))
                self.assertNotIn("MinaGuard", user_agent)
                self.assertNotIn("Python-urllib", user_agent)

    def test_server_hiding_changes_from_the_legacy_checker_is_detected(self):
        path = "/_next/static/chunks/worker.js"
        with ContentServer(self.bodies.copy()) as server:
            server.legacy_checker_bodies[path] = server.bodies[path]
            server.bodies[path] = b"postMessage('changed');"
            self.assertIn(f"{path}: content hash mismatch", self.check(server))

    def test_gzip_transport_keeps_same_content_hash(self):
        with ContentServer(self.bodies.copy()) as server:
            server.gzip_paths.update(("/", "/_next/static/chunks/app.js"))
            self.assertEqual(self.check(server), [])

    def test_missing_asset_is_detected(self):
        with ContentServer(self.bodies.copy()) as server:
            del server.bodies["/_next/static/chunks/app.js"]
            self.assertIn("/_next/static/chunks/app.js: HTTP 404", self.check(server))

    def test_off_origin_redirect_is_rejected(self):
        with ContentServer(self.bodies.copy()) as server:
            server.redirects["/"] = "https://evil.example/"
            self.assertIn("/: HTTP redirect rejected", self.check(server))

    def test_missing_or_weakened_page_headers_are_detected(self):
        weaker_csp = integrity.EXPECTED_CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'", "frame-ancestors *")
        cases = {
            "Content-Security-Policy": ([], "Expected exactly one Content-Security-Policy header, got 0"),
            "X-Frame-Options": (["SAMEORIGIN"], "X-Frame-Options is not DENY"),
            "X-Content-Type-Options": ([], "Expected exactly one X-Content-Type-Options header, got 0"),
        }
        for name, (values, message) in cases.items():
            with self.subTest(header=name), ContentServer(self.bodies.copy()) as server:
                server.page_headers[name] = values
                self.assertIn(f"/: {message}", self.check(server))
        with ContentServer(self.bodies.copy()) as server:
            server.page_headers["Content-Security-Policy"] = [weaker_csp]
            self.assertIn("/: Content-Security-Policy differs from the approved policy", self.check(server))

    def test_a_second_policy_header_is_rejected(self):
        # Browsers enforce every policy they receive, so an extra header can
        # only add limits, but it means something other than the approved
        # release is shaping the page.
        with ContentServer(self.bodies.copy()) as server:
            server.page_headers["Content-Security-Policy"] = [integrity.EXPECTED_CONTENT_SECURITY_POLICY] * 2
            self.assertIn("/: Expected exactly one Content-Security-Policy header, got 2", self.check(server))

    def test_hsts_must_cover_subdomains_for_a_year(self):
        for value in ("max-age=31536000", "max-age=86400; includeSubDomains", "includeSubDomains"):
            with self.subTest(hsts=value), ContentServer(self.bodies.copy()) as server:
                server.page_headers["Strict-Transport-Security"] = [value]
                failures = self.check(server)
                self.assertTrue(any(f.startswith("/: Strict-Transport-Security must") for f in failures), failures)
        with ContentServer(self.bodies.copy()) as server:
            server.page_headers["Strict-Transport-Security"] = ["max-age=63072000; includeSubDomains; preload"]
            self.assertEqual(self.check(server), [])

    def test_watcher_policy_matches_the_ui_policy(self):
        # The app sends CONTENT_SECURITY_POLICY from this module; the watcher
        # must expect the same bytes or every check would fail after a change.
        source = UI_POLICY_MODULE.read_text(encoding="utf-8")
        match = re.search(r'^export const CONTENT_SECURITY_POLICY = "([^"\n]+)";$', source, re.MULTILINE)
        self.assertIsNotNone(match, "CONTENT_SECURITY_POLICY must stay a one-line double-quoted string")
        self.assertEqual(match.group(1), integrity.EXPECTED_CONTENT_SECURITY_POLICY)

    def test_manifest_rejects_missing_route_and_bad_asset_url(self):
        broken = json.loads(json.dumps(self.manifest))
        del broken["routes"]["/transactions/new"]
        with self.assertRaises(integrity.IntegrityError):
            integrity.validate_manifest(broken)
        broken = json.loads(json.dumps(self.manifest))
        broken["assets"]["https://evil.example/app.js"] = DIGEST
        with self.assertRaises(integrity.IntegrityError):
            integrity.validate_manifest(broken)

    def test_baseline_rejects_unsupported_or_unbuilt_route(self):
        with self.assertRaises(integrity.IntegrityError):
            integrity.make_baseline(self.next_root, DIGEST, SOURCE_SHA, ("/accounts/[address]",))
        with self.assertRaises(integrity.IntegrityError):
            integrity.make_baseline(self.next_root, DIGEST, SOURCE_SHA, ("/unbuilt",))

    def test_public_url_requires_https(self):
        with self.assertRaises(integrity.IntegrityError):
            integrity.check_public(self.manifest, "http://app.minaguard.com")
        with self.assertRaises(integrity.IntegrityError):
            integrity.check_public(self.manifest, "https://user:pass@app.minaguard.com")

    def test_duplicate_manifest_fields_are_rejected(self):
        path = Path(self.temp.name) / "duplicate.json"
        path.write_text('{"schema_version":1,"schema_version":1}', encoding="utf-8")
        with self.assertRaises(integrity.IntegrityError):
            integrity.load_manifest(path)


if __name__ == "__main__":
    unittest.main()
