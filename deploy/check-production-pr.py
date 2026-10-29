#!/usr/bin/env python3
"""Check that a production PR merges the exact reviewed main tree."""

import argparse
import json
import re
import subprocess
import sys
import time


REPOSITORY = "zksecurity/mina-guard"


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


def check_pr(number: str, head_sha: str, base_sha: str) -> dict:
    if not re.fullmatch(r"[1-9][0-9]*", number):
        raise ValueError("invalid PR number")
    sha(head_sha)
    sha(base_sha)

    def check_refs() -> dict:
        pr = api(f"pulls/{number}")
        if (pr.get("state") != "open"
                or pr.get("base", {}).get("ref") != "production"
                or pr.get("base", {}).get("repo", {}).get("full_name") != REPOSITORY
                or pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY
                or pr.get("head", {}).get("ref") != "main"
                or pr.get("head", {}).get("sha") != head_sha
                or pr.get("base", {}).get("sha") != base_sha):
            raise ValueError("PR repository, head, or production base changed; refresh the PR check")
        if pr.get("mergeable") is False:
            raise ValueError("production PR must have a conflict-free merge result")
        return pr

    for attempt in range(10):
        pr = check_refs()
        if pr.get("mergeable") is True and pr.get("merge_commit_sha"):
            break
        if attempt < 9:
            time.sleep(1)
    else:
        raise ValueError("GitHub has not computed a merge result; rerun this check")
    merge_sha = sha(pr.get("merge_commit_sha"))
    main_sha = sha(api("git/ref/heads/main").get("object", {}).get("sha"))
    if main_sha != head_sha:
        raise ValueError("production PR must use the current main commit")
    if tree(merge_sha) != tree(main_sha):
        raise ValueError("production merge result must exactly match main")
    latest = check_refs()
    if latest.get("mergeable") is not True or latest.get("merge_commit_sha") != merge_sha:
        raise ValueError("production merge result changed during the check")
    if sha(api("git/ref/heads/main").get("object", {}).get("sha")) != main_sha:
        raise ValueError("main changed during this check; refresh the production PR")
    return {"headSha": head_sha, "baseSha": base_sha, "mergeSha": merge_sha}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr-number", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--base-sha", required=True)
    args = parser.parse_args()
    try:
        result = check_pr(args.pr_number, args.head_sha, args.base_sha)
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Production PR rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
