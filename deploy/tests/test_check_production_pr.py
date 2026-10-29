"""Production merge must contain exactly the reviewed current main tree."""

import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'check_production_pr', Path(__file__).resolve().parents[1] / 'check-production-pr.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
BASE, HEAD, MERGE, OTHER = (char * 40 for char in 'abcd')


class ProductionCheckTest(unittest.TestCase):
    def setUp(self):
        repository = {'full_name': checker.REPOSITORY}
        self.pr = {'state': 'open', 'mergeable': True, 'merge_commit_sha': MERGE,
                   'head': {'sha': HEAD, 'ref': 'main', 'repo': repository},
                   'base': {'sha': BASE, 'ref': 'production', 'repo': repository}}
        self.entries = [
            {'path': 'deploy/script.py', 'type': 'blob', 'mode': '100644', 'sha': HEAD},
            {'path': 'deps/contract', 'type': 'commit', 'mode': '160000', 'sha': BASE},
        ]
        self.trees = {HEAD: self.entries, MERGE: copy.deepcopy(self.entries)}
        self.calls = []

    def api(self, path):
        self.calls.append(path)
        if path == 'pulls/171':
            return copy.deepcopy(self.pr)
        if path == 'git/ref/heads/main':
            return {'object': {'sha': HEAD}}
        if path.startswith('git/commits/'):
            return {'tree': {'sha': path.rsplit('/', 1)[-1]}}
        if path.startswith('git/trees/'):
            commit = path.split('/')[2].split('?')[0]
            return {'truncated': False, 'tree': copy.deepcopy(self.trees[commit])}
        raise AssertionError(path)

    def check(self, api=None):
        with patch.object(checker, 'api', side_effect=api or self.api):
            return checker.check_pr('171', HEAD, BASE)

    def test_main_to_production_accepts_matching_merge_tree(self):
        self.assertEqual(self.check()['mergeSha'], MERGE)
        self.assertEqual(self.calls.count('git/ref/heads/main'), 2)
        self.assertEqual(self.calls.count('pulls/171'), 2)

    def test_rejects_partial_merge_extra_file_mode_and_submodule_changes(self):
        for replacement in [
            self.entries[:1],
            self.entries + [{'path': 'extra', 'type': 'blob', 'mode': '100644', 'sha': OTHER}],
            [self.entries[0] | {'mode': '100755'}, self.entries[1]],
            [self.entries[0], self.entries[1] | {'sha': OTHER}],
        ]:
            with self.subTest(replacement=replacement):
                self.trees[MERGE] = replacement
                with self.assertRaises(ValueError):
                    self.check()

    def test_rejects_stale_branch_wrong_repository_or_conflict(self):
        for field, value in [
            ('state', 'closed'), ('mergeable', False),
        ]:
            previous = self.pr[field]
            self.pr[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.check()
            self.pr[field] = previous
        self.pr['merge_commit_sha'] = None
        with patch.object(checker.time, 'sleep'), self.assertRaises(ValueError):
            self.check()
        self.pr['merge_commit_sha'] = MERGE
        for field, values in [
            ('head', {'ref': 'other'}), ('head', {'sha': OTHER}),
            ('head', {'repo': {'full_name': 'other/repo'}}),
            ('base', {'ref': 'main'}), ('base', {'sha': OTHER}),
        ]:
            previous = copy.deepcopy(self.pr[field])
            self.pr[field].update(values)
            with self.subTest(field=field, values=values), self.assertRaises(ValueError):
                self.check()
            self.pr[field] = previous

    def test_rejects_movement_during_check(self):
        for ref in ['pulls/171', 'git/ref/heads/main']:
            self.calls.clear()
            def api(path):
                value = self.api(path)
                if path == ref and self.calls.count(path) == 2:
                    if path.startswith('pulls/'):
                        value['merge_commit_sha'] = OTHER
                    else:
                        value['object']['sha'] = OTHER
                return value
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                self.check(api)

    def test_rejects_incomplete_tree_and_invalid_entries(self):
        for kind in ['truncated', 'duplicate', 'mode']:
            def api(path):
                result = self.api(path)
                if path.startswith('git/trees/'):
                    if kind == 'truncated':
                        result['truncated'] = True
                    elif kind == 'duplicate':
                        result['tree'].append(result['tree'][0])
                    else:
                        result['tree'][0]['mode'] = '000000'
                return result
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.check(api)


if __name__ == '__main__':
    unittest.main()
