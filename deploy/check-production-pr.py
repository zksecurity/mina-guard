#!/usr/bin/env python3
"""Accept a release-pointer change or a complete sync from reviewed main."""

import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


REPOSITORY = "zksecurity/mina-guard"
POINTER = "deploy/production-release.json"


def sha(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("expected a full commit or object ID")
    return value


def api(path: str) -> dict:
    result = subprocess.run(
        ["gh", "api", f"repos/{REPOSITORY}/{path}"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode:
        raise ValueError("GitHub could not supply the production PR data")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("unexpected GitHub response")
    return value


def tree(commit: str) -> dict[str, tuple[str, str, str]]:
    commit_data = api(f"git/commits/{sha(commit)}")
    tree_sha = sha(commit_data.get("tree", {}).get("sha"))
    value = api(f"git/trees/{tree_sha}?recursive=1")
    if value.get("truncated") is not False or not isinstance(value.get("tree"), list):
        raise ValueError("cannot check an incomplete Git tree")
    entries = {}
    seen = set()
    for entry in value["tree"]:
        path = entry.get("path")
        if (not isinstance(path, str) or path in seen or "\0" in path
                or any(part in ("", ".", "..") for part in path.split("/"))):
            raise ValueError("invalid or duplicate Git tree path")
        seen.add(path)
        kind, mode = entry.get("type"), entry.get("mode")
        object_sha = sha(entry.get("sha"))
        if (kind, mode) not in {
            ("tree", "040000"), ("blob", "100644"), ("blob", "100755"),
            ("blob", "120000"), ("commit", "160000"),
        }:
            raise ValueError("unexpected Git tree entry type or mode")
        if kind != "tree":
            entries[path] = (kind, mode, object_sha)
    return entries


def without_pointer(entries: dict) -> dict:
    return {path: entry for path, entry in entries.items() if path != POINTER}


def classify(base: dict, head: dict, main: dict | None = None) -> str:
    if base == head:
        raise ValueError("production PR has no file changes")
    if base.get(POINTER) != head.get(POINTER):
        if without_pointer(base) != without_pointer(head):
            raise ValueError("a release change cannot also update production code")
        if head.get(POINTER, ())[:2] != ("blob", "100644"):
            raise ValueError("release pointer must be a regular non-executable file")
        return "promotion"
    if main is None or without_pointer(head) != without_pointer(main):
        raise ValueError("sync must copy the complete current main tree and preserve the release pointer")
    return "sync"


def check_pr(number: str, head_sha: str, base_sha: str, record_output: Path) -> dict:
    if not re.fullmatch(r"[1-9][0-9]*", number):
        raise ValueError("invalid PR number")
    sha(head_sha)
    sha(base_sha)

    def check_refs() -> None:
        pr = api(f"pulls/{number}")
        if (pr.get("state") != "open"
                or pr.get("base", {}).get("ref") != "production"
                or pr.get("base", {}).get("repo", {}).get("full_name") != REPOSITORY
                or pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY
                or pr.get("head", {}).get("sha") != head_sha
                or pr.get("base", {}).get("sha") != base_sha):
            raise ValueError("PR repository, head, or production base changed; refresh the PR check")

    check_refs()
    # Requiring the current base in the PR head makes its tree the merge result.
    comparison = api(f"compare/{base_sha}...{head_sha}")
    if comparison.get("status") != "ahead":
        raise ValueError("update the PR branch with the current production branch first")
    base, head = tree(base_sha), tree(head_sha)
    main_sha = None
    main = None
    if base.get(POINTER) == head.get(POINTER):
        main_sha = sha(api("git/ref/heads/main").get("object", {}).get("sha"))
        main = tree(main_sha)
    kind = classify(base, head, main)
    record = None
    if kind == "promotion":
        blob_sha = head[POINTER][2]
        blob = api(f"git/blobs/{blob_sha}")
        size = blob.get("size")
        if (type(size) is not int or not 0 < size <= 4096
                or blob.get("encoding") != "base64" or not isinstance(blob.get("content"), str)):
            raise ValueError("invalid release-pointer blob")
        record = base64.b64decode(blob["content"].replace("\n", ""), validate=True)
        digest = hashlib.sha1(f"blob {len(record)}\0".encode() + record).hexdigest()
        if len(record) != size or digest != blob_sha:
            raise ValueError("release-pointer bytes do not match the checked Git tree")
    check_refs()
    if main_sha and sha(api("git/ref/heads/main").get("object", {}).get("sha")) != main_sha:
        raise ValueError("main changed during this check; refresh the sync PR")
    if record is not None:
        record_output.write_bytes(record)
    return {"kind": kind, "headSha": head_sha, "baseSha": base_sha, "mainSha": main_sha}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr-number", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--record-output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = check_pr(args.pr_number, args.head_sha, args.base_sha, args.record_output)
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a", encoding="utf-8") as stream:
                stream.write(f"kind={result['kind']}\n")
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, subprocess.TimeoutExpired, binascii.Error) as error:
        print(f"Production PR rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
