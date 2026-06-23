// @ts-nocheck
// Embed the plonk WASM binary so the compiled binary is fully self-contained.
// Bun embeds imported file assets into its $bunfs virtual filesystem.
// We patch the CJS require("fs").readFileSync to redirect WASM loads.
//
// Filesystem-relative import that goes through the top-level
// node_modules/o1js/ symlink that bun creates on workspace install — stable
// across npm-vs-github cache layouts (i.e., whether bun cached o1js as
// .bun/o1js@<version>/ for npm or .bun/o1js@github+.../ for a github dep).
// A package-name import (`o1js/dist/...`) would be cleaner but doesn't work:
// o1js's package.json declares a conditional `exports` field, which blocks
// any subpath that isn't explicitly exported.
//
// Previous versions of this file imported through `.bun/o1js@github+
// mellowcroc+o1js+e0a1022/...` — that hardcoded a specific bun cache key
// for the old mesa-srs-fix fork, and broke when we bumped to
// o1js@3.0.0-mesa.final on npm (the cache key changed).
import embeddedWasmPath from "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/plonk_wasm_bg.wasm";

const nodeFs = require("fs");
const _origReadFileSync = nodeFs.readFileSync;
nodeFs.readFileSync = function (path, ...args) {
  if (typeof path === "string" && path.endsWith("plonk_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedWasmPath, ...args);
  }
  return _origReadFileSync(path, ...args);
};
