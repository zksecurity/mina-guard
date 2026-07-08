// @ts-nocheck
// Embed WASM binaries so the compiled binary is fully self-contained.
// Bun embeds imported file assets into its $bunfs virtual filesystem; we patch
// the CJS require("fs").readFileSync to redirect WASM loads to the embedded copies.
//
// Two WASM entry points ship with o1js:
//   plonk_wasm_bg.wasm  — entry via plonk_wasm.cjs
//   kimchi_wasm_bg.wasm — entry via kimchi_wasm.cjs (node-backend.js uses this)
//
// The import path is filesystem-relative (through the top-level node_modules/o1js
// symlink) rather than a package import (`o1js/dist/...`): o1js's package.json
// declares a conditional `exports` field that blocks any subpath not explicitly
// exported, so the package-style import fails to resolve.
import embeddedPlonkWasmPath from "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/plonk_wasm_bg.wasm";
import embeddedKimchiWasmPath from "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/kimchi_wasm_bg.wasm";

const nodeFs = require("fs");
const _origReadFileSync = nodeFs.readFileSync;
nodeFs.readFileSync = function (p, ...args) {
  if (typeof p === "string" && p.endsWith("plonk_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedPlonkWasmPath, ...args);
  }
  if (typeof p === "string" && p.endsWith("kimchi_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedKimchiWasmPath, ...args);
  }
  return _origReadFileSync(p, ...args);
};

// ── kimchi_wasm.cjs resolution fix ──────────────────────────────────────────
//
// In a Bun compiled binary, ALL bundled ESM modules share the same
// import.meta.url — the binary's own URL. node-backend.js's
//   const require = createRequire(import.meta.url)
//   const wasm = requireKimchiWasm(...)  // calls require('../../compiled/.../kimchi_wasm.cjs')
// resolves that relative path against the binary URL, reaching a path that
// doesn't exist on macOS.
//
// We must NOT eagerly require kimchi_wasm.cjs here, because workers call
// requireKimchiWasm(workerData.memory) which patches WebAssembly.Memory before
// the require so that the wasm-bindgen rayon thread pool gets the shared
// SharedArrayBuffer. If we pre-load it, that patch is bypassed and workers
// initialize with wrong (non-shared) memory, crashing wbg_rayon_start_worker.
//
// Fix: store a thunk that uses the literal-string bundled require (which Bun
// can trace and embed, and which is per-thread in worker_threads so each
// thread gets a fresh evaluation). Write a CJS stub to a real temp-dir path
// that calls this thunk, and redirect Module._resolveFilename to that stub.
//
// The thunk is stored in global so the temp-file stub (loaded from real disk)
// can reach it — global is shared within a single thread's runtime.
//
// NOTE: do NOT also patch module.createRequire. Bun calls createRequire
// internally when bridging ESM → CJS imports (e.g. `await import('*.cjs')`).
// Returning a wrapper function without the standard .resolve/.cache properties
// breaks that interop and causes unrelated CJS modules (like o1js_node.bc.cjs)
// to fail with "Cannot find module '...' from ''".

global.__kimchiRequire = function () {
  return require(
    "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/kimchi_wasm.cjs"
  );
};

// Write stub to a real filesystem path so _resolveFilename can return it.
const _kimchiStubPath =
  require("os").tmpdir() + "/__mina_guard_kimchi_wasm.cjs";
nodeFs.writeFileSync(_kimchiStubPath, "module.exports = global.__kimchiRequire();\n");

const _nodeModule = require("module");

// Intercept Module._resolveFilename so that any CJS require() for
// kimchi_wasm.cjs (relative paths only, to avoid a circular loop when the
// stub itself is loaded) returns the real-filesystem stub instead of a
// nonexistent $bunfs path.
const _origResolveFilename = _nodeModule._resolveFilename;
_nodeModule._resolveFilename = function (request, parent, isMain, options) {
  if (
    typeof request === "string" &&
    request.endsWith("kimchi_wasm.cjs") &&
    !require("path").isAbsolute(request)
  ) {
    return _kimchiStubPath;
  }
  return _origResolveFilename.call(this, request, parent, isMain, options);
};
