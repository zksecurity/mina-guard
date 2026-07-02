// Must be imported BEFORE o1js so that when o1js creates its
// FinalizationRegistry (kimchi_bindings/js/bindings/util.js), it gets this
// no-op class.  With IDB-cached compile, o1js's decodeProverKey creates WASM
// wrappers that share underlying pointers; the original finalizer frees a
// pointer the prover still holds after the first prove(), causing dangling
// WASM memory on subsequent proves.  Disabling auto-free is safe — WASM heap
// is reclaimed when the worker is torn down on page refresh.
(globalThis as any).FinalizationRegistry = class {
  register() {}
  unregister() { return false; }
};
