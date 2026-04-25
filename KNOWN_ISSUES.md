# Known Issues

## [Resolved] Stale browser cache causes worker crash after preview rebuild

**Symptom:** "Generating keypair..." hangs indefinitely. The Web Worker crashes with an undefined error. `crossOriginIsolated` and `SharedArrayBuffer` are both `true` — the issue is not COOP/COEP.

**Root cause:** Next.js sets `Cache-Control: s-maxage=31536000, stale-while-revalidate` on statically generated HTML pages. After a preview environment rebuild, the browser serves the old cached HTML which references old JS chunk URLs. When old and new chunks mix, the o1js Web Worker fails to load and every Comlink call (including `generateKeypair`) hangs forever.

This does not affect content-hashed static assets (`/_next/static/chunks/273-47bc1a09b6f3af9c.js`) — those have unique URLs per build and cache correctly. The problem is only with the HTML page, which has a stable URL (`/preview/1/`) but changing content between builds.

**Fix:** The preview Caddy overrides `Cache-Control` to `no-cache` on HTML responses, while letting hashed static assets keep their long-term cache headers. See `preview-env/Caddyfile.preview` — the `/_next/static/*` handler passes upstream headers through, while the catch-all frontend handler strips `Cache-Control` and sets `no-cache`.

`no-cache` does not mean "don't cache" — it means "always revalidate with the server before using a cached copy." If nothing changed, the server returns 304 with no data transfer.

**Why this doesn't affect production (Render):** Platforms like Vercel and Render automatically purge their CDN cache on deploy, so stale HTML is never served. The preview environment uses Caddy without CDN cache purging, which is why the override is needed.

---

## UI state staleness after on-chain operations

**Status:** Partially mitigated
**Severity:** Low (most cases are display glitches; one critical case already fixed)

### Root cause

After an on-chain transaction is submitted, `startOperation` (in `ui/app/layout.tsx`) calls `refreshState` immediately — before the block is mined and before the indexer has processed it. This means the refresh reads stale data from the backend, and React state remains stale until the next `useMultisig` polling cycle (every 15 seconds).

The backend itself becomes correct once the indexer processes the block (indexer polls every 5 seconds). The staleness is purely in the React state layer.

```
tx submitted
    ↓
refreshState() → fetches backend → gets old state (block not mined yet)
    ↓                                                         ↓
React state = stale                              [block mines, indexer runs]
    ↓                                            backend DB = correct
useMultisig 15s poll fires → React state = correct
```

### Fixed case

**`configNonce` in proposal creation** — After a governance transaction (addOwner, removeOwner, changeThreshold, setDelegate) executes, the on-chain `configNonce` increments. If the user creates a new proposal before the 15-second poll fires, the proposal signature would embed the old (wrong) `configNonce`, causing the on-chain contract to reject it with no way to recover without re-creating the proposal.

Fix: `handleProposalSubmit` (in `ui/app/page.tsx`) fetches fresh contract data from the backend immediately before creating any proposal, bypassing the stale React state.

### Remaining cases (UX glitches, not on-chain data corruption)

| Field | Stale after | Symptom | Severity |
|-------|-------------|---------|----------|
| `owners[]`, `numOwners` | addOwner / removeOwner | Duplicate-owner and owner-exists checks in ProposalForm may pass/fail incorrectly; on-chain contract still rejects invalid proposals | Low |
| `threshold` | changeThreshold | ProposalForm validation for removeOwner and the threshold slider show the old value | Low |
| `delegate` | setDelegate / undelegate | Dashboard shows old delegate address for up to 15s | Low |
| `ownersCommitment` | Setup | "New Proposal" button stays disabled for up to 15s after a successful setup | Low |

These are UX annoyances, not silent data corruption. The on-chain contract enforces all invariants regardless of what the UI shows.

### Proper fix (not yet implemented)

Instead of refreshing immediately after tx submission, `startOperation` should:
1. Wait until the indexer has processed the block containing the transaction.
2. Then call `refreshState`.

The backend already exposes `GET /indexer/status` (returns `lastIndexedBlock`) which could be polled for this purpose. The main missing piece is knowing which block the submitted transaction landed in, which requires a separate on-chain query or waiting for tx confirmation before refreshing.

---

## [Resolved] WASM GC corruption causes second prove to hang when using IDB compile cache

**Symptom:** "Generating proof..." hangs on the second transaction without a page refresh. Only happens when caching is enabled; works every time without cache.

**Root cause:** o1js registers a `FinalizationRegistry` (`kimchi_bindings/js/bindings/util.js`) that auto-frees WASM heap memory when JS wrapper objects are garbage-collected. When `compile({ cache })` deserializes prover keys from IDB via `decodeProverKey`, intermediate JS wrappers are created that share underlying WASM pointers with the final key objects. For example, `verifierIndexFromRust(vkWasm)` converts `vkWasm` into a nested-array format — both reference the same WASM heap data. After the conversion, `vkWasm` goes out of scope and becomes GC-eligible.

After the first `prove()`, V8 GC collects these intermediate wrappers. The `FinalizationRegistry` fires and calls `.free()` on their WASM pointers — but the prover still references those pointers through the converted structures. The second `prove()` hits dangling WASM memory and silently hangs.

Without cache, keys are created through Pickles' Rust compilation path which manages WASM object lifetimes internally — no shared pointers, no premature finalization.

```
compile({ cache })
    ↓
decodeProverKey(bytes) → wasm.caml_pasta_fp_plonk_index_decode(bytes, srs)
    ↓
JS wrapper A (__wbg_ptr: 42) → registered with FinalizationRegistry
    ↓
verifierIndexFromRust(A) → nested array structure (still references ptr 42)
    ↓
wrapper A goes out of scope, only nested array is kept
    ↓
first prove() works fine
    ↓
GC collects wrapper A → finalizer calls .free() on ptr 42
    ↓
second prove() → prover reads freed memory at ptr 42 → hang
```

**Fix:** `ui/lib/disable-wasm-finalizers.ts` overrides `globalThis.FinalizationRegistry` with a no-op class before o1js loads. WASM objects are never auto-freed; memory is reclaimed when the worker is torn down on page refresh. This is imported as the first line of the worker (`import './disable-wasm-finalizers'`) so it runs before o1js's module initialization creates its registry.
