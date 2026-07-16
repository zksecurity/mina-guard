# Backend Indexer Architecture

Moved: the canonical, up-to-date architecture and security documentation for
the backend lives at
[`docs/backend-audit-guide.md`](../docs/backend-audit-guide.md).

Quick orientation (see the full doc for the tick pipeline, reorg model, and data model):

- The backend is a polling **indexer** + Express **read API**. It holds no keys
  and is **untrusted for integrity** — its damage ceiling is censorship / DoS /
  display lies, because clients re-hash and the contract re-verifies.
- Two modes: `full` (scan the whole chain) and `lite` (only subscribed
  contracts; the desktop shell's posture). Full-mode discovery is pluggable
  via `DISCOVERY_BACKEND` (`daemon` bestChain scan vs. `archive` postgres SQL).
- The data model is **append-only**: every mutation is stamped with the block
  it became valid at, so reorg rollback is a single `DELETE WHERE > forkHeight`.
- Reorgs within ~290 blocks are auto-handled; deeper forks need operator
  intervention (display-layer only).

Operator concerns — setup, env vars, API routes, troubleshooting — are folded
into the [Operations section](../docs/backend-audit-guide.md#operations) of the
full doc.
