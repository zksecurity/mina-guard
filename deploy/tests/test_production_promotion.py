"""Release promotion must pin one successful attested main-branch build."""

import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


DEPLOY = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


promotion = load("production_promotion_test", "production-promotion.py")
resolver = load("mainnet_deployment_resolver_test", "resolve-mainnet-deployment.py")
SHA = "a" * 40
BACKEND = "ghcr.io/zksecurity/mina-guard/mainnet-backend@sha256:" + "b" * 64
FRONTEND = "ghcr.io/zksecurity/mina-guard/mainnet-frontend@sha256:" + "c" * 64
MANIFEST = {
    "network": "mainnet", "sha": SHA, "vk_hash": "123", "backend": BACKEND,
    "frontend": FRONTEND, "public_config": {
        "api_base_url": "https://app.minaguard.com",
        "mina_endpoint": "https://app.minaguard.com/graphql",
        "archive_endpoint": "https://app.minaguard.com/archive",
        "block_explorer_url": "https://minascan.io/mainnet",
    },
}
MANIFEST_RAW = json.dumps(MANIFEST).encode()
RECORD = {
    "version": 1, "sourceSha": SHA, "runId": "123",
    "manifestSha256": "sha256:" + hashlib.sha256(MANIFEST_RAW).hexdigest(),
}


class PromotionTest(unittest.TestCase):
    def test_record_rejects_ambiguous_or_malformed_release_identity(self):
        self.assertEqual(promotion.record_from_bytes(json.dumps(RECORD).encode()), RECORD)
        invalid = [
            b'{"version":1,"version":1}',
            json.dumps(RECORD | {"version": True}).encode(),
            json.dumps(RECORD | {"runId": "latest"}).encode(),
            json.dumps(RECORD | {"sourceSha": "main"}).encode(),
            json.dumps(RECORD | {"manifestSha256": "sha256:" + "0" * 64, "extra": True}).encode(),
        ]
        for raw in invalid:
            with self.subTest(raw=raw[:80]), self.assertRaises(ValueError):
                promotion.record_from_bytes(raw)

    def test_candidate_requires_exact_run_and_manifest_before_attestation(self):
        content = {
            "schema_version": 1, "source_sha": SHA,
            "frontend_digest": FRONTEND.rsplit("@", 1)[1], "routes": {}, "assets": {},
        }

        def gh(args, **_kwargs):
            if args[1:3] == ["run", "view"]:
                return json.dumps({
                    "headSha": SHA, "headBranch": "main", "event": "push",
                    "conclusion": "success", "workflowName": promotion.WORKFLOW,
                })
            if args[1:3] == ["run", "download"]:
                target = Path(args[args.index("--dir") + 1])
                (target / "mainnet-images.json").write_bytes(MANIFEST_RAW)
                (target / "mainnet-content.json").write_text(json.dumps(content))
                return ""
            raise AssertionError(args)

        with patch.object(promotion, "command", side_effect=gh), \
             patch.object(promotion.verifier, "verify_file_bytes") as files, \
             patch.object(promotion.verifier, "verify_attestation") as images:
            self.assertEqual(promotion.verify_candidate(RECORD), MANIFEST)
            self.assertEqual(files.call_count, 2)
            self.assertEqual(images.call_count, 2)
            files.reset_mock()
            images.reset_mock()
            with self.assertRaises(ValueError):
                promotion.verify_candidate(RECORD | {"manifestSha256": "sha256:" + "0" * 64})
            files.assert_not_called()
            images.assert_not_called()

        for change in [{"headBranch": "production"}, {"event": "pull_request"},
                       {"workflowName": "other"}, {"conclusion": "failure"}]:
            def bad_run(args, **_kwargs):
                if args[1:3] != ["run", "view"]:
                    raise AssertionError("artifact downloaded before run identity check")
                return json.dumps({"headSha": SHA, "headBranch": "main", "event": "push",
                                   "conclusion": "success", "workflowName": promotion.WORKFLOW} | change)
            with self.subTest(change=change), patch.object(promotion, "command", side_effect=bad_run), \
                 self.assertRaises(ValueError):
                promotion.verify_candidate(RECORD)

    def test_watcher_uses_only_last_successful_ops_authored_receipt(self):
        def api(path):
            if path.endswith("deployments?environment=mainnet&per_page=100"):
                return [
                    {"id": 3, "creator": {"id": 9}, "ref": "b" * 40, "payload": RECORD},
                    {"id": 2, "creator": {"id": 7}, "ref": SHA, "payload": RECORD},
                    {"id": 1, "creator": {"id": 9}, "ref": SHA, "payload": RECORD},
                ]
            if "/3/" in path:
                return [{"state": "failure", "creator": {"id": 9}}]
            if "/1/" in path:
                return [{"state": "success", "creator": {"id": 9}}]
            raise AssertionError(path)
        with patch.object(resolver, "api", side_effect=api):
            self.assertEqual(resolver.resolve(9), RECORD)
        with patch.object(resolver, "api", return_value=[
            {"id": 1, "creator": {"id": 9}, "ref": "b" * 40, "payload": RECORD}
        ]), self.assertRaises(ValueError):
            resolver.resolve(9)


if __name__ == "__main__":
    unittest.main()
