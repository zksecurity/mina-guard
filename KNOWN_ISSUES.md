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

## [Mitigated] WASM GC corruption causes second prove to hang when using IDB compile cache

**Symptom:** "Generating proof..." hangs on the second transaction without a page refresh. Only happens when caching is enabled; works every time without cache.

**Root cause:** There are two layers of `FinalizationRegistry` that interact badly during the cache restore path.

All WASM structs live in linear memory (a single `ArrayBuffer`). Each JS wrapper is a thin `wasm_bindgen` object holding `__wbg_ptr` — an integer offset into that buffer.

**Layer 1 (unverified) — wasm_bindgen's per-class registry:** When `wasm_bindgen` is built with the `weak-refs` feature, each generated class has its own `FinalizationRegistry`. The static `__wrap()` method (used by property getters like `vk.srs`) creates a wrapper and registers it for automatic cleanup. **We have not confirmed whether o1js's wasm_bindgen build enables `weak-refs`** — the generated glue code (`plonk_wasm.js`) is not checked into the repo and is produced at build time. If `weak-refs` is not enabled, Bug 1 below does not apply.

**Layer 2 — o1js's registry:** `freeOnFinalize` (in `conversion-core.ts` and `kimchi_bindings/js/bindings/util.js`) registers wrappers with a `FinalizationRegistry`.

There are two implementations of `freeOnFinalize`:
- `util.js` creates the representative via `x.constructor.__wrap()`, which goes through `wasm_bindgen`'s `__wrap` and may trigger a per-class registration — **double-free risk if `weak-refs` is enabled**.
- `conversion-core.ts` creates the representative via `Object.create(Class.prototype)` (its own `wrap()` function), bypassing `wasm_bindgen` entirely — no double-free from the representative itself.

### Bug 1 (unverified): Double-free from dual registry registration

This bug depends on `wasm_bindgen`'s `weak-refs` feature being enabled. If it is: when `verifierIndexFromRust` (`conversion-verifier-index.ts:270`) accesses `vk.srs`, the `wasm_bindgen` getter creates a wrapper via `__wrap()` and registers it with the per-class `FinalizationRegistry`. Then `freeOnFinalize(vk.srs)` registers it with o1js's registry as well. On GC, both registries fire and free the same WASM pointer — use-after-free.

### Bug 2: Dropped JS references to WASM-internal dependencies

`decodeProverKey` (`prover-keys.ts`) drops JS references to objects that the WASM side still depends on:

```js
// prover-keys.ts — StepProvingKey case
let srs = Pickles.loadSrsFp();                              // JS wrapper for SRS
let index = wasm.caml_pasta_fp_plonk_index_decode(bytes, srs); // WASM stores SRS pointer internally
return [KeyType.StepProvingKey, [0, index, cs]];             // srs wrapper NOT returned
// → srs goes out of scope, GC-eligible — but WASM prover index still uses it
```

The WASM decode function stores the SRS pointer inside the prover index struct, but this is a WASM-internal reference invisible to JS GC. The `srs` wrapper becomes unreachable, gets collected, and the finalizer frees the SRS memory while the prover index still holds a dangling pointer to it.

This bug only triggers if `loadSrsFp()` creates a new wrapper each time (i.e., each call returns a fresh JS object wrapping the same WASM pointer). If `loadSrsFp()` returns a globally-held singleton, the wrapper stays alive and this bug does not apply — Bug 1 (double-free) would be the actual culprit instead. We have not verified which behavior `loadSrsFp()` has.

### Why this only affects the cache path

Without cache, keys are created through Pickles' Rust compilation path which manages WASM object lifetimes internally — no shared pointers exposed to JS, no premature finalization.

With cache, `decodeProverKey` deserializes artifacts directly, creating JS wrappers for WASM objects via `wasm_bindgen` getters and conversion functions — exposing shared pointers to the JS/finalizer boundary.

Bug 1 flow (if `weak-refs` is enabled):
```
vk.srs getter → wasm_bindgen __wrap() → registered with per-class FinalizationRegistry
    ↓
freeOnFinalize(vk.srs) → also registered with o1js's FinalizationRegistry
    ↓
GC collects wrapper → both registries fire → double-free on same WASM pointer
```

Bug 2 flow (if `loadSrsFp()` returns a fresh wrapper each call):
```
decodeProverKey(bytes)
    ↓
srs = loadSrsFp()  →  JS wrapper (__wbg_ptr: 100)
    ↓
wasm.caml_pasta_fp_plonk_index_decode(bytes, srs)
    ↓                         ↓
returns index wrapper    WASM prover index struct internally holds ptr 100
    ↓
return [StepProvingKey, [0, index, cs]]   ← srs wrapper NOT kept
    ↓
srs wrapper goes out of scope, GC-eligible
    ↓
first prove() works fine (GC hasn't run yet)
    ↓
GC collects srs wrapper → finalizer frees WASM memory at ptr 100
    ↓
second prove() → prover index reads freed memory at ptr 100 → hang
```

### Upstream fix: prevent double-free (Bug 1, unverified)

Branch `fix/finalization-double-free` on [mellowcroc/o1js](https://github.com/mellowcroc/o1js/commit/4cc8f403) fixes the double-free by calling `__destroy_into_raw()` before re-registering with o1js's registry:

```ts
if (typeof (instance as any).__destroy_into_raw === 'function') {
  (instance as any).__destroy_into_raw();  // detach from wasm_bindgen's registry
  (instance as any).__wbg_ptr = ptr;       // restore pointer for continued use
}
```

This ensures each WASM pointer has exactly one free path. The fix is in `conversion-core.ts`'s `freeOnFinalize`; the `util.js` variant (which uses `__wrap` for the representative) may need a similar fix.

### Upstream fix: retain SRS wrapper (Bug 2)

Branch `fix/retain-wasm-deps` on [mellowcroc/o1js](https://github.com/mellowcroc/o1js/tree/fix/retain-wasm-deps) fixes the dropped-reference problem by attaching the SRS wrapper as a non-enumerable property on the WASM index object:

```ts
function retainDep(owner: object, dep: object) {
  Object.defineProperty(owner, '_wasmDep', { value: dep });
}
```

This is called in each `decodeProverKey` case after the WASM decode, ensuring the SRS JS wrapper shares the same lifetime as the prover/verifier index. The wrapper stays alive as long as the index does, preventing the finalizer from freeing the SRS while the WASM struct still references it.

### Current workaround

**Fix:** `ui/lib/disable-wasm-finalizers.ts` overrides `globalThis.FinalizationRegistry` with a no-op class before o1js loads. WASM objects are never auto-freed; memory is reclaimed when the worker is torn down on page refresh. This is imported as the first line of the worker (`import './disable-wasm-finalizers'`) so it runs before o1js's module initialization creates its registry.

This workaround can be removed once the upstream fixes are merged into o1js and the vendored copy is updated. Before removing, verify which bug (or both) actually applies by checking whether `wasm_bindgen`'s `weak-refs` feature is enabled in the build and whether `loadSrsFp()` returns a singleton or fresh wrapper.
