"""Production maintenance must preserve the release and match all of main."""

import base64
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "check_production_pr", Path(__file__).resolve().parents[1] / "check-production-pr.py"
)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

BASE, HEAD, MAIN, OLD = (character * 40 for character in "abcd")
POINTER = checker.POINTER
RECORD = b'{"version":1,"sourceSha":"' + b"a" * 40 + b'","runId":"123","manifestSha256":"sha256:' + b"b" * 64 + b'"}'
RECORD_SHA = hashlib.sha1(f"blob {len(RECORD)}\0".encode() + RECORD).hexdigest()


def file(digest, mode="100644", kind="blob"):
    return kind, mode, digest


BASE_TREE = {".github/workflows/check.yml": file(OLD), "deploy/check.py": file(OLD), POINTER: file(OLD)}
MAIN_TREE = {".github/workflows/check.yml": file(MAIN), "deploy/check.py": file(MAIN)}
SYNC_TREE = MAIN_TREE | {POINTER: BASE_TREE[POINTER]}


class ShapeTests(unittest.TestCase):
    def test_release_pointer_only(self):
        self.assertEqual(checker.classify(BASE_TREE, BASE_TREE | {POINTER: file(RECORD_SHA)}), "promotion")
        base = checker.without_pointer(BASE_TREE)
        self.assertEqual(checker.classify(base, base | {POINTER: file(RECORD_SHA)}), "promotion")

    def test_complete_sync_preserves_existing_pointer(self):
        self.assertEqual(checker.classify(BASE_TREE, SYNC_TREE, MAIN_TREE), "sync")

    def test_sync_before_first_release(self):
        self.assertEqual(checker.classify(checker.without_pointer(BASE_TREE), MAIN_TREE, MAIN_TREE), "sync")

    def test_sync_copies_additions_deletions_and_renames(self):
        main = {"deploy/renamed-check.py": file(MAIN), ".github/new.yml": file(HEAD)}
        self.assertEqual(checker.classify(BASE_TREE, main | {POINTER: file(OLD)}, main), "sync")
        with self.assertRaises(ValueError):
            checker.classify(BASE_TREE, SYNC_TREE, main)

    def test_rejects_partial_sync_even_when_changed_file_matches_main(self):
        partial = BASE_TREE | {"deploy/check.py": MAIN_TREE["deploy/check.py"]}
        with self.assertRaises(ValueError):
            checker.classify(BASE_TREE, partial, MAIN_TREE)

    def test_rejects_stale_main_and_unreviewed_files(self):
        for head in [SYNC_TREE | {"deploy/check.py": file(OLD)}, SYNC_TREE | {"extra": file(HEAD)}]:
            with self.subTest(head=head), self.assertRaises(ValueError):
                checker.classify(BASE_TREE, head, MAIN_TREE)

    def test_rejects_mixed_release_and_sync_or_pointer_deletion(self):
        for head in [SYNC_TREE | {POINTER: file(RECORD_SHA)}, MAIN_TREE, checker.without_pointer(BASE_TREE)]:
            with self.subTest(head=head), self.assertRaises(ValueError):
                checker.classify(BASE_TREE, head, MAIN_TREE)

    def test_compares_modes_symlinks_and_submodule_commits(self):
        for entry in [file(MAIN, "100755"), file(MAIN, "120000"), file(MAIN, "160000", "commit")]:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                checker.classify(BASE_TREE, SYNC_TREE | {"deploy/check.py": entry}, MAIN_TREE)
        main = MAIN_TREE | {"deps/library": file(MAIN, "160000", "commit")}
        with self.assertRaises(ValueError):
            checker.classify(BASE_TREE, SYNC_TREE | {"deps/library": file(OLD, "160000", "commit")}, main)

    def test_pointer_mode_changes_and_symlinks_are_rejected(self):
        for mode in ["100755", "120000"]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                checker.classify(BASE_TREE, BASE_TREE | {POINTER: file(OLD, mode)})

    def test_rejects_empty_change(self):
        with self.assertRaises(ValueError):
            checker.classify(BASE_TREE, BASE_TREE, MAIN_TREE)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "release.json"
        repo = {"full_name": checker.REPOSITORY}
        self.pr = {"state": "open", "head": {"sha": HEAD, "repo": repo},
                   "base": {"sha": BASE, "ref": "production", "repo": repo}}
        self.trees = {BASE: BASE_TREE, HEAD: SYNC_TREE, MAIN: MAIN_TREE}
        self.responses = {"pulls/171": self.pr, "compare/" + BASE + "..." + HEAD: {"status": "ahead"},
                          "git/ref/heads/main": {"object": {"sha": MAIN}}}
        self.calls = []

    def api(self, path):
        self.calls.append(path)
        if path in self.responses:
            return copy.deepcopy(self.responses[path])
        if path.startswith("git/commits/"):
            return {"tree": {"sha": path.rsplit("/", 1)[1]}}
        if path.startswith("git/trees/"):
            commit = path.split("/")[2].split("?")[0]
            return {"truncated": False, "tree": [
                {"path": path, "type": entry[0], "mode": entry[1], "sha": entry[2]}
                for path, entry in self.trees[commit].items()
            ]}
        if path == f"git/blobs/{RECORD_SHA}":
            return {"encoding": "base64", "size": len(RECORD), "content": base64.b64encode(RECORD).decode()}
        raise AssertionError(path)

    def run_check(self, api=None):
        with patch.object(checker, "api", side_effect=api or self.api):
            return checker.check_pr("171", HEAD, BASE, self.output)

    def test_sync_reads_pinned_trees_without_loading_release(self):
        self.assertEqual(self.run_check()["mainSha"], MAIN)
        self.assertFalse(self.output.exists())
        self.assertFalse(any(path.startswith("git/blobs/") for path in self.calls))
        self.assertEqual(self.calls.count("git/ref/heads/main"), 2)

    def test_promotion_stages_exact_bytes_for_existing_attestation_verifier(self):
        self.trees[HEAD] = BASE_TREE | {POINTER: file(RECORD_SHA)}
        self.assertEqual(self.run_check()["kind"], "promotion")
        self.assertEqual(self.output.read_bytes(), RECORD)
        self.assertNotIn("git/ref/heads/main", self.calls)

    def test_wrong_repository_head_base_or_closed_pr_is_rejected(self):
        for field, value in [("head", {"sha": OLD}), ("base", {"sha": OLD}),
                             ("head", {"repo": {"full_name": "other/repo"}}),
                             ("base", {"ref": "main"})]:
            original = copy.deepcopy(self.pr[field])
            self.pr[field].update(value)
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.run_check()
            self.pr[field] = original
        self.pr["state"] = "closed"
        with self.assertRaises(ValueError):
            self.run_check()

    def test_head_must_include_current_production_base(self):
        for status in ["diverged", "behind", "identical"]:
            self.responses[f"compare/{BASE}...{HEAD}"] = {"status": status}
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.run_check()

    def test_incomplete_tree_is_rejected(self):
        def api(path):
            value = self.api(path)
            if path.startswith("git/trees/"):
                value["truncated"] = True
            return value
        with self.assertRaises(ValueError):
            self.run_check(api)

    def test_tree_parser_rejects_duplicate_paths_and_unknown_modes(self):
        for corruption in ["duplicate", "mode"]:
            def api(path):
                value = self.api(path)
                if path.startswith("git/trees/"):
                    if corruption == "duplicate":
                        value["tree"].append(value["tree"][0])
                    else:
                        value["tree"][0]["mode"] = "000000"
                return value
            with self.subTest(corruption=corruption), self.assertRaises(ValueError):
                self.run_check(api)

    def test_main_or_pr_moving_during_check_is_rejected(self):
        for ref in ["git/ref/heads/main", "pulls/171"]:
            self.calls.clear()
            def api(path):
                value = self.api(path)
                if path == ref and self.calls.count(path) == 2:
                    if path.startswith("pulls/"):
                        value["head"]["sha"] = OLD
                    else:
                        value["object"]["sha"] = OLD
                return value
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                self.run_check(api)
            self.assertFalse(self.output.exists())

    def test_blob_must_match_approved_tree_and_size_limit(self):
        self.trees[HEAD] = BASE_TREE | {POINTER: file(RECORD_SHA)}
        for change in [{"size": 4097}, {"content": base64.b64encode(b"other").decode()},
                       {"encoding": "utf8"}, {"content": "!"}]:
            def api(path):
                value = self.api(path)
                return value | change if path.startswith("git/blobs/") else value
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_check(api)
            self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
