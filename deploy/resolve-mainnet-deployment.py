#!/usr/bin/env python3
"""Resolve the last successful ops-authored mainnet deployment for the watcher."""

import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys


REPOSITORY = "zksecurity/mina-guard"
spec = importlib.util.spec_from_file_location(
    "production_promotion", Path(__file__).with_name("production-promotion.py")
)
assert spec and spec.loader
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


def api(path: str) -> object:
    try:
        result = subprocess.run(
            ["gh", "api", path], text=True, capture_output=True, check=False, timeout=30
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("GitHub deployment history is unavailable") from error
    if result.returncode:
        raise ValueError("GitHub deployment history is unavailable")
    return json.loads(result.stdout)


def resolve(actor_id: int, environment: str = 'mainnet') -> dict[str, object]:
    if environment not in ('mainnet', 'mainnet-preview'):
        raise ValueError('unsupported deployment environment')
    deployments = api(f"repos/{REPOSITORY}/deployments?environment={environment}&per_page=100")
    if not isinstance(deployments, list):
        raise ValueError("unexpected deployment history")
    for deployment in deployments:
        if not isinstance(deployment, dict) or type(deployment.get("id")) is not int:
            raise ValueError("unexpected deployment entry")
        creator = deployment.get("creator")
        if not isinstance(creator, dict) or creator.get("id") != actor_id:
            continue
        statuses = api(f"repos/{REPOSITORY}/deployments/{deployment['id']}/statuses?per_page=1")
        if not isinstance(statuses, list) or not statuses:
            continue
        status = statuses[0]
        if (not isinstance(status, dict) or status.get("state") != "success"
                or not isinstance(status.get("creator"), dict)
                or status["creator"].get("id") != actor_id):
            continue
        payload = deployment.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("successful deployment is missing its approved release")
        record = promotion.record_from_bytes(json.dumps(payload).encode())
        if deployment.get("ref") != record["sourceSha"]:
            raise ValueError("successful deployment ref disagrees with approved release")
        return record
    raise ValueError("no successful ops-authored mainnet deployment was found")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ops-actor-id", required=True)
    parser.add_argument('--environment', choices=('mainnet', 'mainnet-preview'), default='mainnet')
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[1-9][0-9]*", args.ops_actor_id):
            raise ValueError("configure the exact ops GitHub App actor ID")
        record = resolve(int(args.ops_actor_id), args.environment)
    except (ValueError, OSError) as error:
        print(f"Mainnet watcher has no trusted release: {error}", file=sys.stderr)
        return 1
    print(json.dumps(record, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
