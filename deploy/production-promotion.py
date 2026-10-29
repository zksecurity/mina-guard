#!/usr/bin/env python3
"""Check a production release record against one attested mainnet build."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


REPOSITORY = "zksecurity/mina-guard"
WORKFLOW = "Mainnet images (build and attest; no deploy)"
RECORD_KEYS = {"version", "sourceSha", "runId", "manifestSha256"}
VERIFIER_PATH = Path(__file__).with_name("verify-mainnet-release.py")
spec = importlib.util.spec_from_file_location("mainnet_release_verifier", VERIFIER_PATH)
assert spec and spec.loader
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def command(args: list[str], *, timeout: int = 180) -> str:
    try:
        result = subprocess.run(args, text=True, capture_output=True, check=False, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"{args[0]} could not complete") from error
    if result.returncode:
        raise ValueError(f"{args[0]} failed while checking the production candidate")
    return result.stdout


def record_from_bytes(raw: bytes) -> dict[str, object]:
    if len(raw) > 4096:
        raise ValueError("production record is too large")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=verifier.unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("production record must be UTF-8 JSON") from error
    if not isinstance(value, dict) or value.keys() != RECORD_KEYS:
        raise ValueError("production record has unexpected fields")
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("unsupported production record version")
    if not isinstance(value["sourceSha"], str) or not re.fullmatch(r"[0-9a-f]{40}", value["sourceSha"]):
        raise ValueError("sourceSha must be a full lowercase commit ID")
    if not isinstance(value["runId"], str) or not re.fullmatch(r"[1-9][0-9]*", value["runId"]):
        raise ValueError("runId must identify one build run")
    if not isinstance(value["manifestSha256"], str) or not re.fullmatch(
        r"sha256:[0-9a-f]{64}", value["manifestSha256"]
    ):
        raise ValueError("manifestSha256 must pin the exact manifest bytes")
    return value


def verify_candidate(record: dict[str, object], *, check_preview: bool = False) -> dict[str, object]:
    sha = str(record["sourceSha"])
    run_id = str(record["runId"])
    run = json.loads(command([
        "gh", "run", "view", run_id, "--repo", REPOSITORY,
        "--json", "headSha,headBranch,event,conclusion,workflowName",
    ]))
    if (not isinstance(run, dict) or run.get("headSha") != sha or run.get("headBranch") != "production"
            or run.get("event") not in ("push", "workflow_dispatch")
            or run.get("conclusion") != "success" or run.get("workflowName") != WORKFLOW):
        raise ValueError("candidate is not a successful production-branch mainnet build")
    with tempfile.TemporaryDirectory(prefix="minaguard-promotion-") as directory:
        artifact = Path(directory)
        command([
            "gh", "run", "download", run_id, "--repo", REPOSITORY,
            "--name", f"mainnet-images-{sha}", "--dir", str(artifact),
        ], timeout=300)
        manifest_path = artifact / "mainnet-images.json"
        content_path = artifact / "mainnet-content.json"
        if any(path.is_symlink() or not path.is_file() for path in (manifest_path, content_path)):
            raise ValueError("candidate release artifact is incomplete")
        manifest_raw = verifier.read_small(manifest_path, "manifest", verifier.MAX_MANIFEST_BYTES)
        if "sha256:" + hashlib.sha256(manifest_raw).hexdigest() != record["manifestSha256"]:
            raise ValueError("candidate manifest does not match the reviewed hash")
        manifest = verifier.validate_manifest(manifest_raw, sha)
        content_raw = verifier.read_small(
            content_path, "content manifest", verifier.MAX_CONTENT_MANIFEST_BYTES
        )
        verifier.validate_content_manifest(content_raw, sha, str(manifest["frontend"]))
        verifier.verify_file_bytes(manifest_raw, "mainnet-images.json", sha, "manifest")
        verifier.verify_file_bytes(content_raw, "mainnet-content.json", sha, "content manifest")
        for kind in ("backend", "frontend"):
            verifier.verify_attestation("oci://" + str(manifest[kind]), sha, kind)
        if check_preview:
            command([sys.executable, str(VERIFIER_PATH.with_name("mainnet-content-integrity.py")),
                     "check", "--manifest", str(content_path),
                     "--base-url", "https://app.minaguard.com"], timeout=300)
        return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True, type=Path)
    parser.add_argument("--check-preview", action="store_true",
                        help="also check the production-origin preview from this machine")
    args = parser.parse_args()
    try:
        record = record_from_bytes(args.record.read_bytes())
        manifest = verify_candidate(record, check_preview=args.check_preview)
    except (OSError, ValueError) as error:
        print(f"Production promotion rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"approved": record, "images": {
        "frontend": manifest["frontend"], "backend": manifest["backend"],
    }, "vkHash": manifest["vk_hash"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
