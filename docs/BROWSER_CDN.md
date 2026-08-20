# Browser and CDN Usage

## Browser ESM

With Vite, webpack, Rollup, Next.js client code, or another browser bundler:

```js
import {
  encodeText,
  renderToCanvas,
  scanFile,
  startCameraScanner
} from "quadqr-js/browser";
```

The main `quadqr-js` entry also works in modern browser bundlers for runtime-neutral APIs.

## Render to canvas

```js
const code = encodeText("Hello browser");

renderToCanvas(code, document.querySelector("#qr"), {
  moduleSize: 12,
  quietZone: 4,
  style: "classic"
});
```

Available styles are `classic`, `depth`, `soft`, and `inset`.

## Scan an uploaded image

```js
const input = document.querySelector("#image");
const result = await scanFile(input.files[0]);

console.log(result.text);
```

If the symbol uses Secure Payload, the scan result has `secure: true` and `requiresDecryption: true` until it is successfully unlocked.

## Live camera scanning

```js
const video = document.querySelector("#camera");

const scanner = await startCameraScanner(video, {
  scanInterval: 120,
  async onDecode(result) {
    console.log(result);
    scanner.stop();
  },
  onError(error) {
    console.error(error);
  }
});
```

Camera access requires HTTPS or localhost.

## Decrypt a secure scan

```js
import { decryptDecoded } from "quadqr-js/browser";

const locked = await scanFile(file);

if (locked.secure) {
  const unlocked = await decryptDecoded(locked, {
    password: "my-password"
  });

  console.log(unlocked.text);
}
```

Raw-key mode uses `{ key }` instead of `{ password }`.

## Classic script tag

The global browser build exposes `window.QuadQR` / `globalThis.QuadQR`.

```html
<canvas id="qr"></canvas>
<script src="https://cdn.jsdelivr.net/npm/quadqr-js@1.0.0/dist/quadqr.min.js"></script>
<script>
  const code = QuadQR.encodeText("Hello CDN");

  QuadQR.renderToCanvas(code, document.querySelector("#qr"), {
    moduleSize: 12,
    quietZone: 4
  });
</script>
```

## unpkg

```html
<script src="https://unpkg.com/quadqr-js@1.0.0/dist/quadqr.min.js"></script>
```

## Direct CDN ESM

```html
<script type="module">
  import {
    encodeText,
    renderToCanvas
  } from "https://cdn.jsdelivr.net/npm/quadqr-js@1.0.0/dist/browser.js";

  const code = encodeText("ES module CDN");
  renderToCanvas(code, document.querySelector("#qr"));
</script>
```

## Optional WASM from a CDN

The classic global build can resolve the bundled WASM asset relative to its own script URL:

```js
await QuadQR.initWasm();
```

You can also provide a custom URL:

```js
await QuadQR.initWasm({
  url: "https://example.com/assets/quadqr-core.wasm"
});
```

WASM is optional. The normal JavaScript implementation remains available if it cannot load.

## Production recommendation

Pin a concrete package version such as `@1.0.0` in CDN URLs so an existing site does not silently change when a newer package version becomes available.
