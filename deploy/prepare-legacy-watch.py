#!/usr/bin/env python3
"""Prepare an old main-branch release for the independent watcher."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

REPO = 'zksecurity/mina-guard'
URL = f'https://raw.githubusercontent.com/{REPO}/8db9b16b0c0cf097d727ea35d3aafa7554a2e68e/deploy/verify-mainnet-release.py'
HASH = 'f0efecaad4bb8a9b69dd1afae7ec60d2da3a2d7af1ed4a65fcabdbe5b169cc3f'
WORKFLOW = 'Mainnet images (build and attest; no deploy)'


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=300, check=False)
    if result.returncode:
        raise ValueError('Legacy release data is unavailable')
    return result.stdout


def prepare(sha, run_id, directory):
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise ValueError('Invalid legacy release identity')
    run = json.loads(command(['gh', 'run', 'view', run_id, '--repo', REPO,
                              '--json', 'headSha,headBranch,event,conclusion,workflowName']))
    if (run.get('headSha') != sha or run.get('headBranch') != 'main'
            or run.get('event') not in ('push', 'workflow_dispatch')
            or run.get('conclusion') != 'success' or run.get('workflowName') != WORKFLOW):
        raise ValueError('Legacy release is not an approved main-branch build')
    command(['gh', 'run', 'download', run_id, '--repo', REPO,
             '--name', f'mainnet-images-{sha}', '--dir', str(directory)])
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args):
            raise ValueError('Legacy verifier redirect rejected')
    with urllib.request.build_opener(NoRedirect).open(URL, timeout=20) as source:
        raw = source.read(128 * 1024 + 1)
    if len(raw) > 128 * 1024 or hashlib.sha256(raw).hexdigest() != HASH:
        raise ValueError('Legacy verifier does not match the reviewed hash')
    (directory / 'legacy-verifier.py').write_bytes(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        prepare(args.sha, args.run_id, args.directory)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Legacy watcher preparation failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
