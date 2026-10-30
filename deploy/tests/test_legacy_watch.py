"""Only a pinned historical main build can use the legacy watcher path."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'prepare-legacy-watch.py'
spec = importlib.util.spec_from_file_location('legacy_watch', path)
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class Response:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self, _limit): return self.data


class LegacyWatchTest(unittest.TestCase):
    def test_only_successful_main_run_is_accepted(self):
        sha = 'a' * 40
        code = b'expected verifier'
        run = {'headSha': sha, 'headBranch': 'main', 'event': 'push',
               'conclusion': 'success', 'workflowName': legacy.WORKFLOW}
        def gh(args):
            if args[1:3] == ['run', 'view']: return json.dumps(run)
            if args[1:3] == ['run', 'download']: return ''
            raise AssertionError(args)
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(legacy, 'command', side_effect=gh) as command, \
             patch.object(legacy, 'HASH', hashlib.sha256(code).hexdigest()), \
             patch.object(legacy.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = Response(code)
            legacy.prepare(sha, '123', Path(directory))
            self.assertEqual((Path(directory) / 'legacy-verifier.py').read_bytes(), code)
            run['headBranch'] = 'production'
            command.reset_mock()
            with self.assertRaises(ValueError):
                legacy.prepare(sha, '123', Path(directory))
            self.assertEqual(command.call_count, 1)


if __name__ == '__main__': unittest.main()
