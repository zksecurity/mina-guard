// @ts-nocheck
// Embed the plonk WASM binary so the compiled binary is fully self-contained.
// Bun embeds imported file assets into its $bunfs virtual filesystem; we patch
// the CJS require("fs").readFileSync to redirect WASM loads to the embedded copy.
//
// The import path is filesystem-relative (through the top-level node_modules/o1js
// symlink) rather than a package import (`o1js/dist/...`): o1js's package.json
// declares a conditional `exports` field that blocks any subpath not explicitly
// exported, so the package-style import fails to resolve.
import embeddedWasmPath from "../../node_modules/o1js/dist/node/bindings/compiled/node_bindings/plonk_wasm_bg.wasm";

const nodeFs = require("fs");
const _origReadFileSync = nodeFs.readFileSync;
nodeFs.readFileSync = function (path, ...args) {
  if (typeof path === "string" && path.endsWith("plonk_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedWasmPath, ...args);
  }
  return _origReadFileSync(path, ...args);
};
