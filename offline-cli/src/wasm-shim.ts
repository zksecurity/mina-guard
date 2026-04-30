// @ts-nocheck
// Embed the plonk WASM binary so the compiled binary is fully self-contained.
// Bun embeds imported file assets into its $bunfs virtual filesystem.
// We patch the CJS require("fs").readFileSync to redirect WASM loads.

import embeddedWasmPath from "../../node_modules/.bun/o1js@github+mellowcroc+o1js+e0a1022/node_modules/o1js/dist/node/bindings/compiled/node_bindings/plonk_wasm_bg.wasm";

const nodeFs = require("fs");
const _origReadFileSync = nodeFs.readFileSync;
nodeFs.readFileSync = function (path, ...args) {
  if (typeof path === "string" && path.endsWith("plonk_wasm_bg.wasm")) {
    return _origReadFileSync(embeddedWasmPath, ...args);
  }
  return _origReadFileSync(path, ...args);
};
