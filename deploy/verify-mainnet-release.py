#!/usr/bin/env python3
"""Verify a mainnet release and emit its digest-pinned deployment inputs.

This is a preflight, not a deployment. The caller supplies a separately
approved source commit and release manifest hash, and must require success
before using these images.
"""

import argparse
import hashlib
import ipaddress
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


REPOSITORY = "zksecurity/mina-guard"
REPOSITORY_ID = "1165883593"
WORKFLOW_IDENTITY = (
    "https://github.com/zksecurity/mina-guard/.github/workflows/"
    "mainnet-image-build.yml@refs/heads/production"
)
IMAGE_PREFIX = "ghcr.io/zksecurity/mina-guard/mainnet"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_CONTENT_MANIFEST_BYTES = 10 * 1024 * 1024
MAX_GRAPHQL_BYTES = 8 * 1024
PUBLIC_CONFIG_KEYS = frozenset(
    {"api_base_url", "mina_endpoint", "archive_endpoint", "block_explorer_url"}
)
MANIFEST_KEYS = frozenset(
    {"network", "sha", "vk_hash", "backend", "frontend", "public_config"}
)


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def validate_public_url(name: str, value: object) -> None:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{name} must be a nonempty HTTPS URL")
    if any(char.isspace() or ord(char) < 32 for char in value) or "\\" in value:
        raise ValueError(f"{name} contains invalid URL characters")
    try:
        url = urlsplit(value)
        host = url.hostname
        port = url.port
    except ValueError as error:
        raise ValueError(f"{name} is not a valid HTTPS URL") from error
    if (
        url.scheme != "https"
        or not host
        or not url.netloc
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or port == 0
    ):
        raise ValueError(f"{name} must be HTTPS without credentials, query, or fragment")
    normalized_host = host.rstrip(".")
    if (
        normalized_host == "localhost"
        or normalized_host.endswith(".localhost")
        or not re.fullmatch(r"[a-z0-9.-]+", normalized_host)
        or "." not in normalized_host
        or any(not label or label.startswith("-") or label.endswith("-")
               for label in normalized_host.split("."))
    ):
        raise ValueError(f"{name} must use a public DNS hostname")
    try:
        ipaddress.ip_address(normalized_host)
    except ValueError:
        pass
    else:
        raise ValueError(f"{name} must use a DNS hostname")
    if re.search(r"(?:^|[^a-z])(?:testnet|devnet|trail)(?:[^a-z]|$)", value.lower()):
        raise ValueError(f"{name} appears to point to a non-mainnet service")


def validate_manifest(raw: bytes, approved_sha: str) -> dict[str, object]:
    try:
        manifest = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("manifest must be valid UTF-8 JSON") from error
    if not isinstance(manifest, dict) or manifest.keys() != MANIFEST_KEYS:
        raise ValueError("manifest must have exactly the mainnet release fields")
    if manifest["network"] != "mainnet":
        raise ValueError("manifest network must be mainnet")
    if manifest["sha"] != approved_sha:
        raise ValueError("manifest SHA does not match the approved source commit")
    if not isinstance(manifest["vk_hash"], str) or not re.fullmatch(
        r"[1-9][0-9]{0,77}", manifest["vk_hash"]
    ):
        raise ValueError("manifest VK hash must be a positive decimal string")
    for name in ("backend", "frontend"):
        expected = rf"{re.escape(IMAGE_PREFIX)}-{name}@sha256:[0-9a-f]{{64}}"
        if not isinstance(manifest[name], str) or not re.fullmatch(
            expected, manifest[name]
        ):
            raise ValueError(f"manifest {name} must be the expected digest-pinned image")
    public_config = manifest["public_config"]
    if not isinstance(public_config, dict) or public_config.keys() != PUBLIC_CONFIG_KEYS:
        raise ValueError("manifest public_config must have exactly the expected URLs")
    for name in PUBLIC_CONFIG_KEYS:
        validate_public_url(name, public_config[name])
    return manifest


def validate_content_manifest(raw: bytes, approved_sha: str, frontend: str) -> None:
    try:
        content = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("content manifest must be valid UTF-8 JSON") from error
    expected_keys = {"schema_version", "source_sha", "frontend_digest", "routes", "assets"}
    if not isinstance(content, dict) or content.keys() != expected_keys:
        raise ValueError("content manifest must have exactly the expected fields")
    if type(content.get("schema_version")) is not int or content["schema_version"] != 1:
        raise ValueError("unsupported content manifest schema version")
    if content.get("source_sha") != approved_sha:
        raise ValueError("content manifest source SHA does not match approved commit")
    if content.get("frontend_digest") != frontend.rsplit("@", 1)[1]:
        raise ValueError("content manifest frontend digest does not match release")
    if not isinstance(content.get("routes"), dict) or not isinstance(content.get("assets"), dict):
        raise ValueError("content manifest must contain route and asset maps")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def check_mina_network(endpoint: str) -> None:
    request = urllib.request.Request(
        endpoint,
        data=b'{"query":"{ networkID }"}',
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError("Mina endpoint did not return HTTP 200")
            raw = response.read(MAX_GRAPHQL_BYTES + 1)
    except (OSError, ValueError) as error:
        raise ValueError("Mina endpoint networkID check failed") from error
    if len(raw) > MAX_GRAPHQL_BYTES:
        raise ValueError("Mina endpoint networkID response is too large")
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Mina endpoint returned invalid networkID JSON") from error
    if (
        not isinstance(result, dict)
        or result.get("errors") not in (None, [])
        or not isinstance(result.get("data"), dict)
        or result["data"].get("networkID") not in ("mainnet", "mina:mainnet")
    ):
        raise ValueError("Mina endpoint did not report mainnet")


def verify_attestation(subject: str, approved_sha: str, label: str, bundle: Path | None = None) -> None:
    command = [
        "gh", "attestation", "verify", subject,
        "--repo", REPOSITORY,
        "--cert-identity", WORKFLOW_IDENTITY,
        "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
        "--source-ref", "refs/heads/production",
        "--source-digest", approved_sha,
        "--predicate-type", "https://slsa.dev/provenance/v1",
        "--deny-self-hosted-runners",
        "--format", "json",
    ]
    if bundle is not None:
        if bundle.is_symlink() or not bundle.is_file() or bundle.stat().st_size > 8 * 1024 * 1024:
            raise ValueError(f"{label} attestation bundle is missing or invalid")
        command.extend(["--bundle", str(bundle)])
    try:
        result = subprocess.run(
            command, text=True, capture_output=True, check=False, timeout=120
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"{label} attestation could not be verified") from error
    if result.returncode != 0:
        raise ValueError(f"{label} attestation could not be verified")
    try:
        verified = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} attestation returned invalid verification output") from error
    if not isinstance(verified, list) or not verified:
        raise ValueError(f"{label} attestation returned no verified result")
    if bundle is not None and not any(
        isinstance(item, dict)
        and item.get("verificationResult", {}).get("signature", {}).get("certificate", {}).get("sourceRepositoryIdentifier") == REPOSITORY_ID
        for item in verified
    ):
        raise ValueError(f"{label} attestation belongs to a different repository")


def read_small(path: Path, label: str, limit: int) -> bytes:
    with path.open("rb") as source:
        raw = source.read(limit + 1)
    if len(raw) > limit:
        raise ValueError(f"{label} is too large")
    return raw


def verify_file_bytes(raw: bytes, name: str, approved_sha: str, label: str, bundle: Path | None = None) -> None:
    # The staged file is identical to the bytes parsed above, so replacing the
    # input path during verification cannot change what was approved.
    with tempfile.TemporaryDirectory(prefix="minaguard-release-") as directory:
        staged = Path(directory) / name
        staged.write_bytes(raw)
        verify_attestation(str(staged), approved_sha, label, bundle)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--approved-sha", required=True)
    parser.add_argument("--approved-manifest-sha256", required=True)
    parser.add_argument("--content-manifest", type=Path)
    parser.add_argument("--bundle-dir", type=Path, help="directory of saved build attestation bundles")
    args = parser.parse_args()

    try:
        if not re.fullmatch(r"[0-9a-f]{40}", args.approved_sha):
            raise ValueError("approved SHA must be the full lowercase 40-character commit ID")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.approved_manifest_sha256):
            raise ValueError("approved manifest hash must be sha256:<64 lowercase hex characters>")
        raw = read_small(args.manifest, "manifest", MAX_MANIFEST_BYTES)
        actual_manifest_sha256 = "sha256:" + hashlib.sha256(raw).hexdigest()
        if actual_manifest_sha256 != args.approved_manifest_sha256:
            raise ValueError("manifest bytes do not match the approved SHA-256 hash")
        manifest = validate_manifest(raw, args.approved_sha)
        bundles = args.bundle_dir
        verify_file_bytes(raw, "mainnet-images.json", args.approved_sha, "manifest",
                          bundles / "manifest.attestation.jsonl" if bundles else None)

        for name in ("backend", "frontend"):
            verify_attestation(
                "oci://" + str(manifest[name]), args.approved_sha, name,
                bundles / f"{name}.attestation.jsonl" if bundles else None,
            )

        if args.content_manifest is not None:
            content_raw = read_small(
                args.content_manifest, "content manifest", MAX_CONTENT_MANIFEST_BYTES
            )
            validate_content_manifest(
                content_raw, args.approved_sha, str(manifest["frontend"])
            )
            verify_file_bytes(
                content_raw, "mainnet-content.json", args.approved_sha,
                "content manifest", bundles / "content.attestation.jsonl" if bundles else None,
            )
            manifest["content_manifest_verified"] = True

        check_mina_network(manifest["public_config"]["mina_endpoint"])
    except (OSError, ValueError) as error:
        print(f"Mainnet release verification failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(manifest, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
