"""Offline and local HTTP checks for the mainnet served-content monitor."""

import importlib.util
import gzip
import json
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

        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path in owner.redirects:
                    self.send_response(302)
                    self.send_header("Location", owner.redirects[self.path])
                    self.end_headers()
                    return
                data = owner.bodies.get(self.path)
                if data is None:
                    self.send_error(404)
                    return
                if self.path in owner.gzip_paths:
                    data = gzip.compress(data)
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
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
