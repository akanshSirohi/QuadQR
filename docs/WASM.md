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
console.log(state);
```

In QuadQR 1.x, the WASM module accelerates CRC-32. Once initialized, normal encode/decode operations automatically use the installed accelerator.

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
<script src="https://cdn.jsdelivr.net/npm/quadqr-js@1.1.0/dist/quadqr.min.js"></script>
<script>
  await QuadQR.initWasm();
</script>
```

## Fallback behavior

WASM is never required for the QuadQR wire format. If your environment cannot load WebAssembly, simply do not call `initWasm()` and continue using the JavaScript implementation.
