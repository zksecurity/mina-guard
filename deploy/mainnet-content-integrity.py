#!/usr/bin/env python3
"""Compare public MinaGuard content with files from an approved frontend image.

The baseline command reads an extracted Next.js build, never the live site.
The caller must extract it from the approved OCI digest and protect the
resulting manifest as part of that release. The check command can then run
outside the app host and exit nonzero for alerting when public content differs.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_ROUTES = (
    "/", "/accounts/new", "/guide", "/settings",
    "/transactions", "/transactions/new",
)
SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SOURCE_SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_MANIFEST_BYTES = 10 * 1024 * 1024
MAX_ASSETS = 10_000
MAX_FAILURES = 5
MAX_CHECK_SECONDS = 300


class IntegrityError(Exception):
    """A release baseline or public response cannot be verified."""


def _sha256_file(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise IntegrityError(f"Expected a regular build file: {path}")
    size = 0
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            size += len(block)
            if size > MAX_FILE_BYTES:
                raise IntegrityError(f"Build file exceeds size limit: {path}")
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def _validate_route(route: str) -> None:
    if (
        not isinstance(route, str)
        or not route.startswith("/")
        or route.startswith("/_next/")
        or (route != "/" and route.endswith("/"))
        or "//" in route
        or any(char in route for char in ("?", "#", "%", "\\", "[", "]"))
        or any(part in (".", "..", "") for part in route.split("/")[1:] if route != "/")
        or not re.fullmatch(r"/[A-Za-z0-9/_-]*", route)
    ):
        raise IntegrityError(f"Unsupported static route: {route!r}")


def _asset_url(relative: Path) -> str:
    if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        raise IntegrityError(f"Invalid static asset path: {relative}")
    return "/_next/static/" + "/".join(quote(part, safe="-._~") for part in relative.parts)


def _validate_asset_url(path: str) -> None:
    if not isinstance(path, str) or not path.startswith("/_next/static/"):
        raise IntegrityError(f"Invalid static asset URL: {path!r}")
    suffix = path[len("/_next/static/") :]
    parts = suffix.split("/")
    if not parts or any(not part for part in parts):
        raise IntegrityError(f"Invalid static asset URL: {path!r}")
    decoded = [unquote(part) for part in parts]
    if any(part in (".", "..") or "/" in part or "\\" in part or "\x00" in part for part in decoded):
        raise IntegrityError(f"Invalid static asset URL: {path!r}")
    if _asset_url(Path(*decoded)) != path:
        raise IntegrityError(f"Noncanonical static asset URL: {path!r}")


def make_baseline(next_root: Path, frontend_digest: str, source_sha: str,
                  extra_routes: tuple[str, ...] = ()) -> dict:
    """Hash static HTML and all static files from an extracted Next.js build."""
    if not isinstance(frontend_digest, str) or not SHA256_RE.fullmatch(frontend_digest):
        raise IntegrityError("Frontend image digest must be sha256:<64 lowercase hex characters>")
    if not isinstance(source_sha, str) or not SOURCE_SHA_RE.fullmatch(source_sha):
        raise IntegrityError("Source SHA must be 40 lowercase hex characters")

    app_dir = next_root / "server" / "app"
    static_dir = next_root / "static"
    if not app_dir.is_dir() or not static_dir.is_dir():
        raise IntegrityError("--next-root must contain server/app and static from the frontend image")

    routes = {}
    for route in sorted(set(DEFAULT_ROUTES).union(extra_routes)):
        _validate_route(route)
        html_path = app_dir / ("index.html" if route == "/" else f"{route[1:]}.html")
        routes[route] = _sha256_file(html_path)

    assets = {}
    for path in sorted(static_dir.rglob("*")):
        if path.is_symlink():
            raise IntegrityError(f"Static build contains a symlink: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise IntegrityError(f"Static build contains a non-file: {path}")
        assets[_asset_url(path.relative_to(static_dir))] = _sha256_file(path)
        if len(assets) > MAX_ASSETS:
            raise IntegrityError("Static build exceeds asset count limit")
    if not any(name.endswith(".js") for name in assets):
        raise IntegrityError("Static build contains no JavaScript")
    if not any(name.endswith(".css") for name in assets):
        raise IntegrityError("Static build contains no CSS")

    return {
        "schema_version": 1,
        "frontend_digest": frontend_digest,
        "source_sha": source_sha,
        "routes": routes,
        "assets": assets,
    }


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise IntegrityError(f"Duplicate manifest field: {key}")
        result[key] = value
    return result


def validate_manifest(manifest: object) -> dict:
    if not isinstance(manifest, dict) or set(manifest) != {
        "schema_version", "frontend_digest", "source_sha", "routes", "assets"
    }:
        raise IntegrityError("Manifest has missing or unknown fields")
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1:
        raise IntegrityError("Unsupported content manifest schema")
    if not isinstance(manifest["frontend_digest"], str) or not SHA256_RE.fullmatch(manifest["frontend_digest"]):
        raise IntegrityError("Invalid frontend image digest in manifest")
    if not isinstance(manifest["source_sha"], str) or not SOURCE_SHA_RE.fullmatch(manifest["source_sha"]):
        raise IntegrityError("Invalid source SHA in manifest")

    routes, assets = manifest["routes"], manifest["assets"]
    if not isinstance(routes, dict) or not set(DEFAULT_ROUTES).issubset(routes):
        raise IntegrityError("Manifest omits a required static route")
    if not isinstance(assets, dict) or not assets or len(assets) > MAX_ASSETS:
        raise IntegrityError("Manifest has an invalid static asset list")
    if set(routes).intersection(assets):
        raise IntegrityError("Manifest route and asset paths overlap")
    if not any(name.endswith(".js") for name in assets) or not any(name.endswith(".css") for name in assets):
        raise IntegrityError("Manifest must cover JavaScript and CSS")
    for route, digest in routes.items():
        _validate_route(route)
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise IntegrityError(f"Invalid hash for route {route}")
    for asset, digest in assets.items():
        _validate_asset_url(asset)
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise IntegrityError(f"Invalid hash for asset {asset}")
    return manifest


def load_manifest(path: Path) -> dict:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise IntegrityError("Manifest exceeds size limit")
    with path.open("r", encoding="utf-8") as source:
        return validate_manifest(json.load(source, object_pairs_hook=_unique_object))


class _RejectRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        raise IntegrityError("HTTP redirect rejected")


def _check_base_url(base_url: str, allow_http_for_tests: bool = False) -> str:
    parsed = urlsplit(base_url)
    if (
        (parsed.scheme != "https" and not (
            allow_http_for_tests and parsed.scheme == "http"
            and parsed.hostname in ("127.0.0.1", "localhost", "::1")
        ))
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query or parsed.fragment
    ):
        raise IntegrityError("Public base URL must be an HTTPS origin without credentials, path, query, or fragment")
    try:
        _ = parsed.port
    except ValueError as error:
        raise IntegrityError("Public base URL has an invalid port") from error
    return base_url.rstrip("/")


def _public_hash(opener, url: str, timeout: float, deadline: float) -> str:
    request = Request(url, headers={
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "MinaGuard-content-integrity/1",
    })
    try:
        with opener.open(request, timeout=timeout) as response:
            if response.status != 200 or response.geturl() != url:
                raise IntegrityError("Unexpected HTTP status or response URL")
            encoding = response.headers.get("Content-Encoding", "identity").lower()
            if encoding not in ("identity", "gzip"):
                raise IntegrityError("Unsupported content encoding")
            # Hash bytes the browser receives after HTTP transport decompression.
            body = gzip.GzipFile(fileobj=response) if encoding == "gzip" else response
            digest = hashlib.sha256()
            size = 0
            read_chunk = getattr(body, "read1", body.read)
            while block := read_chunk(1024 * 1024):
                if time.monotonic() > deadline:
                    raise IntegrityError("Overall check time limit exceeded")
                size += len(block)
                if size > MAX_FILE_BYTES:
                    raise IntegrityError("Public response exceeds size limit")
                digest.update(block)
            return f"sha256:{digest.hexdigest()}"
    except HTTPError as error:
        if 300 <= error.code < 400:
            raise IntegrityError("HTTP redirect rejected") from error
        raise IntegrityError(f"HTTP {error.code}") from error
    except URLError as error:
        raise IntegrityError(f"HTTP request failed: {error.reason}") from error
    except (OSError, EOFError) as error:
        raise IntegrityError("HTTP response could not be read") from error


def check_public(manifest: dict, base_url: str, timeout: float = 15,
                 allow_http_for_tests: bool = False) -> list[str]:
    """Return all mismatched paths; raise for an invalid baseline or URL."""
    validate_manifest(manifest)
    origin = _check_base_url(base_url, allow_http_for_tests)
    if timeout <= 0 or timeout > 120:
        raise IntegrityError("Timeout must be greater than zero and at most 120 seconds")
    opener = build_opener(_RejectRedirect())
    failures = []
    deadline = time.monotonic() + MAX_CHECK_SECONDS
    for path, expected in sorted({**manifest["routes"], **manifest["assets"]}.items()):
        if time.monotonic() > deadline:
            failures.append("Overall check time limit exceeded")
            break
        try:
            actual = _public_hash(opener, origin + path, min(timeout, max(0.1, deadline - time.monotonic())), deadline)
            if actual != expected:
                failures.append(f"{path}: content hash mismatch")
        except IntegrityError as error:
            failures.append(f"{path}: {error}")
        if len(failures) >= MAX_FAILURES:
            failures.append("Stopped after five failures; see first failures above")
            break
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    baseline = sub.add_parser("baseline", help="hash files from an extracted approved frontend image")
    baseline.add_argument("--next-root", type=Path, required=True)
    baseline.add_argument("--frontend-digest", required=True)
    baseline.add_argument("--source-sha", required=True)
    baseline.add_argument("--output", type=Path, required=True)
    baseline.add_argument("--route", action="append", default=[], help="additional pre-rendered static route")
    check = sub.add_parser("check", help="compare public HTTPS responses to an approved manifest")
    check.add_argument("--manifest", type=Path, required=True)
    check.add_argument("--base-url", required=True)
    check.add_argument("--timeout", type=float, default=15)
    args = parser.parse_args(argv)
    try:
        if args.command == "baseline":
            data = make_baseline(args.next_root, args.frontend_digest, args.source_sha, tuple(args.route))
            with args.output.open("x", encoding="utf-8") as output:
                json.dump(data, output, indent=2, sort_keys=True)
                output.write("\n")
            print(f"Wrote content baseline for {len(data['routes'])} routes and {len(data['assets'])} assets")
        else:
            data = load_manifest(args.manifest)
            failures = check_public(data, args.base_url, args.timeout)
            if failures:
                print(f"Content integrity FAILED for {data['frontend_digest']}:", file=sys.stderr)
                for failure in failures:
                    print(f"  {failure}", file=sys.stderr)
                return 1
            print(f"Content integrity OK: {len(data['routes'])} routes, {len(data['assets'])} assets, {data['frontend_digest']}")
        return 0
    except (IntegrityError, OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(f"Content integrity ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
