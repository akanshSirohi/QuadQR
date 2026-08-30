import { ensureWasmBuild } from "./wasm-build.js";

ensureWasmBuild({ force: true, requireCompiler: true })
  .then(() => {
    console.log("QuadQR WASM build complete:");
    console.log("  wasm/quadqr-core.wasm");
    console.log("  wasm/quadqr-core.build.json");
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
