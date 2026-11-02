"""Fail-closed checks for the manual mainnet image build configuration."""

import os
import subprocess
import sys
import unittest
from pathlib import Path


VALIDATOR = Path(__file__).resolve().parents[1] / "validate-mainnet-build-config.py"
VALID_ENV = {
    "NEXT_PUBLIC_MINA_NETWORK": "mainnet",
    "MINA_NETWORK_DOMAIN": "mainnet",
    # Must equal MAINNET_VK_HASH in deploy/verify-mainnet-release.py. Kept as a
    # literal so a pin change has to touch this test deliberately.
    "NEXT_PUBLIC_MINAGUARD_VK_HASH": (
        "11186074123051144955935844547857280472106039209748658876584800516410203862391"
    ),
    "NEXT_PUBLIC_BASE_PATH": "",
    "NEXT_PUBLIC_API_BASE_URL": "https://app.example.org",
    "NEXT_PUBLIC_MINA_ENDPOINT": "https://node.example.org/graphql",
    "NEXT_PUBLIC_ARCHIVE_ENDPOINT": "https://archive.example.org/graphql",
    "NEXT_PUBLIC_BLOCK_EXPLORER_URL": "https://explorer.example.org/mainnet",
}


class MainnetBuildConfigTest(unittest.TestCase):
    def run_validator(self, changes):
        env = os.environ.copy()
        env.update(VALID_ENV)
        env.update(changes)
        return subprocess.run(
            [sys.executable, str(VALIDATOR)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_accepts_explicit_mainnet_config(self):
        self.assertEqual(self.run_validator({}).returncode, 0)

    def test_rejects_missing_or_testnet_endpoint(self):
        for endpoint in ("", "https://node.example.org/testnet/graphql"):
            with self.subTest(endpoint=endpoint):
                self.assertNotEqual(
                    self.run_validator({"NEXT_PUBLIC_MINA_ENDPOINT": endpoint}).returncode,
                    0,
                )

    def test_rejects_domain_mismatch(self):
        self.assertNotEqual(
            self.run_validator({"MINA_NETWORK_DOMAIN": "testnet"}).returncode,
            0,
        )

    def test_rejects_missing_zero_or_unpinned_vk_hash(self):
        for hash_value in ("", "0", "00123", "123456789"):
            with self.subTest(hash_value=hash_value):
                self.assertNotEqual(
                    self.run_validator({"NEXT_PUBLIC_MINAGUARD_VK_HASH": hash_value}).returncode,
                    0,
                )

    def test_rejects_secret_bearing_url(self):
        for endpoint in (
            "https://user:password@node.example.org/graphql",
            "https://node.example.org/graphql?api_key=secret",
        ):
            with self.subTest(endpoint=endpoint):
                self.assertNotEqual(
                    self.run_validator({"NEXT_PUBLIC_MINA_ENDPOINT": endpoint}).returncode,
                    0,
                )

    def test_rejects_localhost_with_final_dns_dot(self):
        for endpoint in (
            "https://localhost./graphql",
            "https://node.localhost./graphql",
        ):
            with self.subTest(endpoint=endpoint):
                self.assertNotEqual(
                    self.run_validator({"NEXT_PUBLIC_MINA_ENDPOINT": endpoint}).returncode,
                    0,
                )


if __name__ == "__main__":
    unittest.main()
