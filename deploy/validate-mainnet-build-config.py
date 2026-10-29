#!/usr/bin/env python3
"""Reject missing or testnet build inputs before publishing mainnet images."""

import ipaddress
import os
import re
import sys
from urllib.parse import urlsplit


URL_VARS = (
    "NEXT_PUBLIC_API_BASE_URL",
    "NEXT_PUBLIC_MINA_ENDPOINT",
    "NEXT_PUBLIC_ARCHIVE_ENDPOINT",
    "NEXT_PUBLIC_BLOCK_EXPLORER_URL",
)


def validate_url(name: str, value: str) -> None:
    if not value or value != value.strip() or any(char.isspace() for char in value):
        raise ValueError(f"{name} must be a nonempty HTTPS URL without whitespace")
    try:
        url = urlsplit(value)
        host = url.hostname
        port = url.port
    except ValueError as error:
        raise ValueError(f"{name} is not a valid HTTPS URL") from error
    if (
        url.scheme != "https"
        or not host
        or not url.netloc
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or port == 0
    ):
        raise ValueError(f"{name} must be an HTTPS URL without credentials, query, or fragment")
    normalized_host = host.rstrip(".")
    if normalized_host == "localhost" or normalized_host.endswith(".localhost"):
        raise ValueError(f"{name} cannot point to localhost")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if "." not in host or not re.fullmatch(r"[a-z0-9.-]+", host):
            raise ValueError(f"{name} must use a DNS hostname") from None
    else:
        raise ValueError(f"{name} must use a DNS hostname")
    if re.search(r"(?:^|[^a-z])(?:testnet|devnet|trail)(?:[^a-z]|$)", value.lower()):
        raise ValueError(f"{name} appears to point to a non-mainnet service")


def main() -> int:
    try:
        if os.environ.get("NEXT_PUBLIC_MINA_NETWORK") != "mainnet":
            raise ValueError("NEXT_PUBLIC_MINA_NETWORK must be mainnet")
        if os.environ.get("MINA_NETWORK_DOMAIN") != "mainnet":
            raise ValueError("MINA_NETWORK_DOMAIN must be mainnet")
        hash_value = os.environ.get("NEXT_PUBLIC_MINAGUARD_VK_HASH", "")
        if not re.fullmatch(r"[1-9][0-9]{0,77}", hash_value):
            raise ValueError("NEXT_PUBLIC_MINAGUARD_VK_HASH must be a positive decimal mainnet VK hash")
        if os.environ.get("NEXT_PUBLIC_BASE_PATH", ""):
            raise ValueError("This AWS mainnet build expects the app at / (no base path)")
        for name in URL_VARS:
            validate_url(name, os.environ.get(name, ""))
    except ValueError as error:
        print(f"Mainnet build config error: {error}", file=sys.stderr)
        return 1
    print("Mainnet build config validated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
