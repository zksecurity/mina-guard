# MinaGuard Contract Architecture

Moved: the canonical, up-to-date architecture and security documentation for
the on-chain contract lives at
[`docs/contracts-audit-guide.md`](../docs/contracts-audit-guide.md).

Quick orientation (see the full doc for the state layout, flow, and invariant map):

- MinaGuard is a hierarchical multisig vault zkApp. Funds move only via a
  proven `execute*` method after a proposal reaches its owner-signature
  threshold. The contract is the system's **trust anchor**.
- Every proposal is keyed by `TransactionProposal.hash()`, re-hashed on-chain
  at approve/execute time — this is what makes an untrusted indexer/UI safe.
- Proposals are **LOCAL** (execute on the same guard) or **REMOTE** (proposed
  on a parent, executed on a child); the hierarchy is capped at two levels.
- Replay is blocked across four domains (LOCAL, REMOTE, cross-contract,
  cross-child) plus cross-network via the compile-time `NETWORK_DOMAIN`.
- Permissions set in `deploy()` (`setPermissions: impossible()`,
  `setVerificationKey: impossibleDuringCurrentVersion()`) make the deploy key
  powerless after deploy.

The invariant → enforcement → test map is in
[`docs/security-audit-guide.md`](../docs/security-audit-guide.md).
