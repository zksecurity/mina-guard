"""Fail-closed tests for the mainnet release preflight."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


VERIFIER = Path(__file__).resolve().parents[1] / "verify-mainnet-release.py"
SPEC = importlib.util.spec_from_file_location("mainnet_release_verifier", VERIFIER)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SHA = "a" * 40
BACKEND = "ghcr.io/zksecurity/mina-guard/mainnet-backend@sha256:" + "b" * 64
FRONTEND = "ghcr.io/zksecurity/mina-guard/mainnet-frontend@sha256:" + "c" * 64
IDENTITY = (
    "https://github.com/zksecurity/mina-guard/.github/workflows/"
    "mainnet-image-build.yml@refs/heads/production"
)


def valid_manifest():
    return {
        "network": "mainnet",
        "sha": SHA,
        "vk_hash": "123456789",
        "backend": BACKEND,
        "frontend": FRONTEND,
        "public_config": {
            "api_base_url": "https://api.minaguard.com",
            "mina_endpoint": "https://node.minaguard.com/graphql",
            "archive_endpoint": "https://archive.minaguard.com/graphql",
            "block_explorer_url": "https://minascan.io/mainnet",
        },
    }


def valid_content_manifest():
    return {
        "schema_version": 1,
        "source_sha": SHA,
        "frontend_digest": FRONTEND.rsplit("@", 1)[1],
        "routes": {},
        "assets": {},
    }


class MainnetReleaseVerifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.manifest_path = self.directory / "mainnet-images.json"
        self.content_path = self.directory / "mainnet-content.json"
        self.log_path = self.directory / "gh-calls.jsonl"
        fake_gh = self.directory / "gh"
        fake_gh.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "with open(os.environ['GH_LOG'], 'a', encoding='utf-8') as log:\n"
            "    log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if os.environ.get('GH_FAIL_SUBJECT') and "
            "os.environ['GH_FAIL_SUBJECT'] in sys.argv[3]:\n"
            "    sys.exit(1)\n"
            "print(os.environ.get('GH_RESULT', '[{}]'))\n",
            encoding="utf-8",
        )
        fake_gh.chmod(0o755)
        self.manifest_path.write_text(json.dumps(valid_manifest()), encoding="utf-8")

    def run_verifier(self, *, sha=SHA, manifest_hash=None, content=False,
                     env_changes=None, network_error=None):
        env = {
            "PATH": f"{self.directory}:{os.environ.get('PATH', '')}",
            "GH_LOG": str(self.log_path),
        }
        env.update(env_changes or {})
        if manifest_hash is None:
            manifest_hash = "sha256:" + hashlib.sha256(self.manifest_path.read_bytes()).hexdigest()
        argv = [
            str(VERIFIER), "--manifest", str(self.manifest_path),
            "--approved-sha", sha,
            "--approved-manifest-sha256", manifest_hash,
        ]
        if content:
            argv += ["--content-manifest", str(self.content_path)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict(os.environ, env),
            patch.object(sys, "argv", argv),
            patch.object(MODULE, "check_mina_network", side_effect=network_error) as check,
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = MODULE.main()
        self.last_network_check = check
        return SimpleNamespace(returncode=code, stdout=stdout.getvalue(), stderr=stderr.getvalue())

    def calls(self):
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text().splitlines()]

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("verification failed", result.stderr)

    def test_verified_release_emits_exact_refs_after_all_attestations_and_network_check(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), valid_manifest())
        self.last_network_check.assert_called_once_with(
            "https://node.minaguard.com/graphql"
        )
        calls = self.calls()
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[0][2].endswith("/mainnet-images.json"))
        self.assertEqual(calls[1][2], "oci://" + BACKEND)
        self.assertEqual(calls[2][2], "oci://" + FRONTEND)
        for call in calls:
            self.assertEqual(call[:2], ["attestation", "verify"])
            self.assertEqual(call[call.index("--repo") + 1], "zksecurity/mina-guard")
            self.assertEqual(call[call.index("--cert-identity") + 1], IDENTITY)
            self.assertEqual(call[call.index("--source-ref") + 1], "refs/heads/production")
            self.assertEqual(call[call.index("--source-digest") + 1], SHA)
            self.assertEqual(
                call[call.index("--predicate-type") + 1],
                "https://slsa.dev/provenance/v1",
            )
            self.assertIn("--deny-self-hosted-runners", call)

    def test_unapproved_sha_and_bad_schema_fail_before_attestation(self):
        for changes, approved in [
            ({"sha": "d" * 40}, SHA),
            ({}, "abc"),
            ({"network": "testnet"}, SHA),
            ({"vk_hash": "0"}, SHA),
            ({"vk_hash": "00123"}, SHA),
            ({"vk_hash": 123}, SHA),
            ({"extra": "unexpected"}, SHA),
        ]:
            with self.subTest(changes=changes, approved=approved):
                manifest = valid_manifest() | changes
                self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                self.assert_rejected(self.run_verifier(sha=approved))
                self.assertEqual(self.calls(), [])

    def test_changed_manifest_bytes_or_invalid_approved_hash_fail_before_attestation(self):
        original_hash = "sha256:" + hashlib.sha256(self.manifest_path.read_bytes()).hexdigest()
        self.manifest_path.write_text(json.dumps(valid_manifest(), indent=2), encoding="utf-8")
        self.assert_rejected(self.run_verifier(manifest_hash=original_hash))
        self.assertEqual(self.calls(), [])
        manifest = valid_manifest()
        manifest["public_config"]["api_base_url"] = "https://changed.minaguard.com"
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        for approved_hash in (
            original_hash,
            "sha256:" + "d" * 64,
            "d" * 64,
            "sha256:" + "D" * 64,
            "sha256:abc",
        ):
            with self.subTest(approved_hash=approved_hash):
                self.assert_rejected(self.run_verifier(manifest_hash=approved_hash))
                self.assertEqual(self.calls(), [])

    def test_malformed_or_duplicate_json_fails_before_attestation(self):
        for raw in ('{"network":', '{"network":"mainnet","network":"mainnet"}'):
            with self.subTest(raw=raw):
                self.manifest_path.write_text(raw, encoding="utf-8")
                self.assert_rejected(self.run_verifier())
                self.assertEqual(self.calls(), [])

    def test_rejects_tags_wrong_image_name_and_malformed_digests(self):
        for field, value in [
            ("backend", "ghcr.io/zksecurity/mina-guard/mainnet-backend:latest"),
            ("backend", "ghcr.io/attacker/mainnet-backend@sha256:" + "b" * 64),
            ("frontend", "ghcr.io/zksecurity/mina-guard/mainnet-backend@sha256:" + "c" * 64),
            ("frontend", "ghcr.io/zksecurity/mina-guard/mainnet-frontend@sha256:123"),
        ]:
            with self.subTest(field=field, value=value):
                manifest = valid_manifest()
                manifest[field] = value
                self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                self.assert_rejected(self.run_verifier())
                self.assertEqual(self.calls(), [])

    def test_rejects_bad_public_urls(self):
        for url in [
            "http://node.minaguard.com/graphql",
            "https://user:secret@node.minaguard.com/graphql",
            "https://node.minaguard.com/graphql?token=secret",
            "https://node.minaguard.com/testnet/graphql",
            "https://localhost./graphql",
            "https://127.0.0.1/graphql",
        ]:
            with self.subTest(url=url):
                manifest = valid_manifest()
                manifest["public_config"]["mina_endpoint"] = url
                self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                self.assert_rejected(self.run_verifier())
                self.assertEqual(self.calls(), [])

    def test_attestation_failure_for_any_subject_is_fail_closed(self):
        for fail_subject, expected_calls in [
            ("mainnet-images.json", 1),
            ("mainnet-backend@", 2),
            ("mainnet-frontend@", 3),
        ]:
            with self.subTest(fail_subject=fail_subject):
                self.log_path.unlink(missing_ok=True)
                self.assert_rejected(
                    self.run_verifier(env_changes={"GH_FAIL_SUBJECT": fail_subject})
                )
                self.assertEqual(len(self.calls()), expected_calls)
                self.last_network_check.assert_not_called()

    def test_zero_verified_results_fail_closed(self):
        self.assert_rejected(self.run_verifier(env_changes={"GH_RESULT": "[]"}))
        self.assertEqual(len(self.calls()), 1)

    def test_signed_content_baseline_is_linked_to_approved_frontend(self):
        self.content_path = self.directory / "downloaded-baseline.json"
        self.content_path.write_text(json.dumps(valid_content_manifest()), encoding="utf-8")
        result = self.run_verifier(content=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertTrue(output.pop("content_manifest_verified"))
        self.assertEqual(output, valid_manifest())
        self.assertEqual(len(self.calls()), 4)
        self.assertTrue(self.calls()[3][2].endswith("/mainnet-content.json"))

    def test_content_baseline_wrong_sha_or_frontend_digest_fails_closed(self):
        for field, value in [
            ("source_sha", "d" * 40),
            ("frontend_digest", "sha256:" + "d" * 64),
            ("schema_version", 2),
        ]:
            with self.subTest(field=field):
                self.log_path.unlink(missing_ok=True)
                content = valid_content_manifest()
                content[field] = value
                self.content_path.write_text(json.dumps(content), encoding="utf-8")
                self.assert_rejected(self.run_verifier(content=True))
                self.assertEqual(len(self.calls()), 3)

    def test_content_baseline_attestation_failure_is_fail_closed(self):
        self.content_path.write_text(json.dumps(valid_content_manifest()), encoding="utf-8")
        self.assert_rejected(
            self.run_verifier(
                content=True, env_changes={"GH_FAIL_SUBJECT": "mainnet-content.json"}
            )
        )
        self.assertEqual(len(self.calls()), 4)

    def test_network_check_failure_is_fail_closed(self):
        self.assert_rejected(self.run_verifier(network_error=ValueError("wrong network")))
        self.assertEqual(len(self.calls()), 3)

    def test_network_check_accepts_only_explicit_mainnet_response(self):
        class Response:
            status = 200

            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return self.body

        for value, accepted in [
            ("mainnet", True),
            ("mina:mainnet", True),
            ("testnet", False),
            ("mina:devnet", False),
            (None, False),
        ]:
            with self.subTest(value=value):
                body = json.dumps({"data": {"networkID": value}}).encode()
                def open_request(request, timeout):
                    self.assertEqual(request.full_url, "https://node.minaguard.com/graphql")
                    self.assertEqual(request.get_method(), "POST")
                    self.assertEqual(request.data, b'{"query":"{ networkID }"}')
                    self.assertEqual(timeout, 10)
                    return Response(body)

                opener = SimpleNamespace(open=open_request)
                with patch.object(MODULE.urllib.request, "build_opener", return_value=opener):
                    if accepted:
                        MODULE.check_mina_network("https://node.minaguard.com/graphql")
                    else:
                        with self.assertRaises(ValueError):
                            MODULE.check_mina_network("https://node.minaguard.com/graphql")

    def test_network_check_rejects_graphql_errors_or_non_200(self):
        class Response:
            def __init__(self, status, body):
                self.status = status
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return self.body

        for status, payload in [
            (302, {"data": {"networkID": "mainnet"}}),
            (200, {"data": {"networkID": "mainnet"}, "errors": [{"message": "bad"}]}),
            (200, {"data": {"networkID": "mainnet"}, "errors": "bad"}),
        ]:
            with self.subTest(status=status, payload=payload):
                opener = SimpleNamespace(
                    open=lambda request, timeout: Response(status, json.dumps(payload).encode())
                )
                with patch.object(MODULE.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaises(ValueError):
                        MODULE.check_mina_network("https://node.minaguard.com/graphql")


if __name__ == "__main__":
    unittest.main()
