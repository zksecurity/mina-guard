# PR #144 screenshots

Captured from the actual MinaGuard proposal page and recovery components at code commit `d4bf8729927178d7a3ca3f2c68df8f199c3711d7` on 2026-09-30.

The vault data comes from the checked-in UI test fixtures. Node/indexer outcomes are simulated to show the recovery states; these images are not evidence of live-chain transactions or physical-wallet testing.

- `01-indexed-data-mismatch.png`: initial stores do not match the chain; Retry / Cancel.
- `02-stale-online-transaction.png`: prepared transaction is stale; Rebuild transaction / Cancel.
- `03-stale-offline-transaction.png`: signed offline transaction is stale; Export fresh request / Cancel.
- `04-already-executed.png`: proposal already executed; execution details still syncing.
- `05-action-unavailable.png`: governance invalidated the proposal; Dismiss.
- `06-node-unavailable.png`: node/state check unavailable; Retry check / Cancel.
- `07-checking-state.png`: checking the latest vault state before wallet handoff.

This branch contains only screenshot assets and their description. It is separate from the implementation branch.
