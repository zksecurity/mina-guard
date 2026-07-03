// @ts-nocheck
// Embed WASM binaries so the compiled binary is fully self-contained.
// Bun embeds imported file assets into its $bunfs virtual filesystem; we patch
// the CJS require("fs").readFileSync to redirect WASM loads to the embedded copies.
//
// Two WASM entry points ship with o1js:
//   plonk_wasm_bg.wasm  — entry via plonk_wasm.cjs
//   kimchi_wasm_bg.wasm — entry via kimchi_wasm.cjs (node-backend.js uses this one)
//
// The import path is filesystem-relative (through the top-level node_modules/o1js
// symlink) rather than a package import (`o1js/dist/...`): o1js's package.json
// declares a conditional `exports` field that blocks any subpath not explicitly
// exported, so the package-style import fails to resolve.
import embeddedPlonkWasmPath from "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/plonk_wasm_bg.wasm";
import embeddedKimchiWasmPath from "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/kimchi_wasm_bg.wasm";

const nodeFs = require("fs");
const _origReadFileSync = nodeFs.readFileSync;
nodeFs.readFileSync = function (path, ...args) {
  if (typeof path === "string" && path.endsWith("plonk_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedPlonkWasmPath, ...args);
  }
  if (typeof path === "string" && path.endsWith("kimchi_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedKimchiWasmPath, ...args);
  }
  return _origReadFileSync(path, ...args);
};

// node-backend.js loads kimchi_wasm.cjs via require(variable) — Bun can't
// statically trace a dynamic path. Requiring it here with a literal string
// forces Bun to bundle it, and loading it post-patch primes the module cache
// so the later dynamic require() in node-backend.js hits the cached module
// (with kimchi_wasm_bg.wasm already initialised at the correct embedded path).
require("../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/kimchi_wasm.cjs");
