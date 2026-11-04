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
    "NEXT_PUBLIC_MINA_ENDPOINT": "https://app.example.org/graphql",
    "NEXT_PUBLIC_ARCHIVE_ENDPOINT": "https://app.example.org/archive",
    "NEXT_PUBLIC_BLOCK_EXPLORER_URL": "https://explorer.example.org/mainnet",
}
# The desktop UI build (desktop/package.json `build:ui`): the API is the
# embedded backend on loopback, and MINA_NETWORK_DOMAIN is not a build input.
DESKTOP_ENV = {
    **{name: value for name, value in VALID_ENV.items() if name != "MINA_NETWORK_DOMAIN"},
    "NEXT_PUBLIC_API_BASE_URL": "http://127.0.0.1:5050",
}


def run_validator(base_env, changes, args=()):
    env = os.environ.copy()
    # A developer shell may export the E2E flag or a network domain; the
    # baseline must not.
    env.pop("NEXT_PUBLIC_E2E_TEST", None)
    env.pop("MINA_NETWORK_DOMAIN", None)
    env.update(base_env)
    env.update(changes)
    return subprocess.run(
        [sys.executable, str(VALIDATOR), *args],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


class MainnetBuildConfigTest(unittest.TestCase):
    def run_validator(self, changes):
        return run_validator(VALID_ENV, changes)

    def test_accepts_explicit_mainnet_config(self):
        result = self.run_validator({})
        self.assertEqual(result.returncode, 0)
        self.assertIn("image build config validated", result.stdout)

    def test_rejects_missing_or_testnet_endpoint(self):
        for endpoint in ("", "https://app.example.org/testnet/graphql"):
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

    def test_rejects_missing_domain(self):
        # The image build compiles the backend for one network, so the domain
        # must be stated explicitly.
        env = {name: value for name, value in VALID_ENV.items() if name != "MINA_NETWORK_DOMAIN"}
        self.assertNotEqual(run_validator(env, {}).returncode, 0)

    def test_rejects_missing_zero_or_unpinned_vk_hash(self):
        for hash_value in ("", "0", "00123", "123456789"):
            with self.subTest(hash_value=hash_value):
                self.assertNotEqual(
                    self.run_validator({"NEXT_PUBLIC_MINAGUARD_VK_HASH": hash_value}).returncode,
                    0,
                )

    def test_rejects_secret_bearing_url(self):
        for endpoint in (
            "https://user:password@app.example.org/graphql",
            "https://app.example.org/graphql?api_key=secret",
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

    def test_rejects_e2e_test_flag(self):
        for value in ("true", "1", "false", " "):
            with self.subTest(value=value):
                result = self.run_validator({"NEXT_PUBLIC_E2E_TEST": value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("NEXT_PUBLIC_E2E_TEST", result.stderr)

    def test_rejects_endpoints_on_another_origin(self):
        # The mainnet page may only connect to its own origin.
        for name, value in (
            ("NEXT_PUBLIC_MINA_ENDPOINT", "https://node.example.org/graphql"),
            ("NEXT_PUBLIC_ARCHIVE_ENDPOINT", "https://app.example.org:8443/archive"),
            ("NEXT_PUBLIC_API_BASE_URL", "https://api.example.org"),
        ):
            with self.subTest(name=name):
                result = self.run_validator({name: value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("share one origin", result.stderr)

    def test_rejects_loopback_api_for_image_build(self):
        # Only the desktop build may point the UI at a loopback backend.
        result = self.run_validator({"NEXT_PUBLIC_API_BASE_URL": "http://127.0.0.1:5050"})
        self.assertNotEqual(result.returncode, 0)

    def test_accepts_empty_e2e_test_flag(self):
        # The frontend Dockerfile defaults the build arg to an empty string,
        # which leaves E2E mode off.
        self.assertEqual(self.run_validator({"NEXT_PUBLIC_E2E_TEST": ""}).returncode, 0)

    def test_rejects_unknown_flag(self):
        result = run_validator(VALID_ENV, {}, args=("--image",))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("usage", result.stderr)


class DesktopBuildConfigTest(unittest.TestCase):
    """`--desktop`: the inputs baked by desktop/package.json `build:ui`."""

    def run_validator(self, changes):
        return run_validator(DESKTOP_ENV, changes, args=("--desktop",))

    def test_accepts_desktop_config(self):
        result = self.run_validator({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("desktop build config validated", result.stdout)

    def test_requires_embedded_backend_api_url(self):
        for value in ("", "https://app.example.org", "http://localhost:5050", "http://127.0.0.1:5051"):
            with self.subTest(value=value):
                result = self.run_validator({"NEXT_PUBLIC_API_BASE_URL": value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("127.0.0.1:5050", result.stderr)

    def test_accepts_node_and_archive_on_different_origins(self):
        # The desktop builds its Content-Security-Policy from the saved
        # endpoints, so the hosted same-origin rule does not apply.
        result = self.run_validator({
            "NEXT_PUBLIC_MINA_ENDPOINT": "https://node.example.org/graphql",
            "NEXT_PUBLIC_ARCHIVE_ENDPOINT": "https://archive.example.org/graphql",
        })
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_plain_http_or_testnet_endpoint(self):
        for name in ("NEXT_PUBLIC_MINA_ENDPOINT", "NEXT_PUBLIC_ARCHIVE_ENDPOINT", "NEXT_PUBLIC_BLOCK_EXPLORER_URL"):
            for value in ("", "http://127.0.0.1:8080/graphql", "https://api.example.org/devnet/graphql"):
                with self.subTest(name=name, value=value):
                    self.assertNotEqual(self.run_validator({name: value}).returncode, 0)

    def test_rejects_testnet_network_or_stray_domain(self):
        for changes in (
            {"NEXT_PUBLIC_MINA_NETWORK": "testnet"},
            {"MINA_NETWORK_DOMAIN": "testnet"},
            {"MINA_NETWORK_DOMAIN": ""},
        ):
            with self.subTest(changes=changes):
                self.assertNotEqual(self.run_validator(changes).returncode, 0)

    def test_accepts_explicit_mainnet_domain(self):
        self.assertEqual(self.run_validator({"MINA_NETWORK_DOMAIN": "mainnet"}).returncode, 0)

    def test_rejects_unpinned_vk_hash(self):
        for hash_value in ("", "0", "123456789"):
            with self.subTest(hash_value=hash_value):
                result = self.run_validator({"NEXT_PUBLIC_MINAGUARD_VK_HASH": hash_value})
                self.assertNotEqual(result.returncode, 0)

    def test_rejects_e2e_flag_and_base_path(self):
        for changes in ({"NEXT_PUBLIC_E2E_TEST": "true"}, {"NEXT_PUBLIC_BASE_PATH": "/app"}):
            with self.subTest(changes=changes):
                self.assertNotEqual(self.run_validator(changes).returncode, 0)


if __name__ == "__main__":
    unittest.main()
