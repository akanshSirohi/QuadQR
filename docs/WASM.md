# WebAssembly

QuadQR includes an optional prebuilt WebAssembly module at:

```text
dist/wasm/quadqr-core.wasm
```

The normal JavaScript implementation works without WASM. Applications can opt in when they want to use the bundled accelerator.

## Enable WASM

```js
import { initWasm } from "quadqr-js";

const state = await initWasm();
console.log(state.accelerators);
// ["crc32", "scanner-preprocess"]
```

The bundled WASM module accelerates both CRC-32 and scanner preprocessing. Scanner acceleration covers the hot full-frame RGBA → grayscale conversion, Otsu threshold calculation, and binary finder image generation used by `scanImageData()` and camera scanning. **Finder-pattern detection, geometry estimation, perspective solving, color classification, and recovery orchestration remain JavaScript.** Once initialized, the existing synchronous scanner API automatically uses the accelerator with the JavaScript implementation kept as the fallback.

## Check the current state

```js
import { getWasmState } from "quadqr-js";

console.log(getWasmState());
```

Before initialization, or after disabling WASM, the result is `null`.

## Disable WASM

```js
import { disableWasm } from "quadqr-js";

disableWasm();
```

QuadQR immediately returns to the JavaScript implementation.

## Custom WASM URL

Browser and CDN applications can override the asset location:

```js
await initWasm({
  url: "https://example.com/assets/quadqr-core.wasm"
});
```

You can also provide WASM bytes directly through the `bytes` option.

## CDN behavior

When the classic `quadqr.min.js` global build is loaded from a CDN, `QuadQR.initWasm()` resolves the bundled sibling WASM asset from the same package/version location.

```html
<script src="https://cdn.jsdelivr.net/npm/quadqr-js@1.5.5/dist/quadqr.min.js"></script>
<script>
  await QuadQR.initWasm();
</script>
```

## Building WASM from source

QuadQR keeps the generated WASM binary and its verification metadata in the repository:

```text
wasm/quadqr-core.wasm
wasm/quadqr-core.build.json
```

For normal development, run:

```bash
npm run build
```

The build hashes the C source, the WASM compiler flags, and the checked-in binary. If all hashes match, it reuses the verified prebuilt binary. If `wasm-src/quadqr_core.c` or the compiler flags changed, the normal build automatically recompiles WASM. A stale WASM build is never silently accepted: if recompilation is required and `clang` is not available in `PATH`, `npm run build` fails with instructions to install LLVM/Clang.

To explicitly rebuild just the WASM accelerator:

```bash
npm run build:wasm
```

`npm run build:wasm` always recompiles and therefore always requires LLVM/Clang. Rust, Cargo, and Emscripten are not required by the current WASM build. `npm publish` runs the normal build through `prepublishOnly`, so the same stale-WASM protection applies before publishing.

## Fallback behavior

WASM is never required for the QuadQR wire format or scanner correctness. If WebAssembly cannot load, keep using the JavaScript scanner. For performance-sensitive browser scanning, initialize WASM once during application startup before calling `scanImageData()` repeatedly or starting the camera scanner.
