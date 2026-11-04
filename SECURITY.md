# Security policy

## Report a vulnerability privately

Do not open a public issue for a security problem. Report it through GitHub's private vulnerability
reporting instead: [open a private report](https://github.com/zksecurity/mina-guard/security/advisories/new)
(Security tab, then "Report a vulnerability"). Only the maintainers can see it.

If you cannot use GitHub, email [hello@zksecurity.xyz](mailto:hello@zksecurity.xyz) with "MinaGuard security"
in the subject.

Please include what is affected, how to reproduce it, and the impact you expect. Never send private keys,
recovery phrases or deploy keys, yours or anyone else's.

## Scope

- The MinaGuard contracts in `contracts/`
- The web interface at app.minaguard.com and the code in `ui/`
- The backend and indexer in `backend/`
- The offline CLI in `offline-cli/` and the desktop app in `desktop/`
- Release, build and deployment code in this repository

Known and accepted risks are listed in
[docs/security-audit-guide.md](docs/security-audit-guide.md#accepted-risks-and-known-limitations).
Reports about them are welcome when they show a new impact.

## Bugs that are not security issues

Use the in-app "Report a bug" link or [open an issue](https://github.com/zksecurity/mina-guard/issues/new/choose).
