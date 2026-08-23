# Browser and CDN Usage

## Browser ESM

With Vite, webpack, Rollup, Next.js client code, or another browser bundler:

```js
import {
  encodeText,
  renderToCanvas,
  renderToSVG,
  scanFile,
  startCameraScanner
} from "quadqr-js/browser";
```

The main `quadqr-js` entry also works in modern browser bundlers for runtime-neutral APIs.

## Render to canvas

```js
const code = encodeText("Hello browser");

renderToCanvas(code, document.querySelector("#qr"), {
  imageSize: 720,
  quietZone: 4,
  style: "classic"
});

const svg = renderToSVG(code, {
  imageSize: 720,
  quietZone: 4
});
```

`imageSize` controls the exact square output size. If neither `imageSize` nor `moduleSize` is supplied, the renderer defaults to 720 × 720 px.

Available styles are `classic`, `depth`, `soft`, and `inset`.

## Compressed, signed, and print-safe output

```js
import {
  assessScanability,
  decodeMatrix,
  encodeText,
  encodeSignedText,
  generateSigningKeyPair,
  renderToCanvas,
  verifyDecodedSignature
} from "quadqr-js/browser";

const compressed = encodeText("repeat repeat repeat repeat", {
  compression: "auto"
});

const keys = await generateSigningKeyPair();
const signed = await encodeSignedText("ticket", {
  compression: "auto",
  privateKey: keys.privateKey,
  keyId: keys.keyId
});

const checked = await verifyDecodedSignature(decodeMatrix(signed.matrix), {
  publicKey: keys.publicKey
});
console.log(checked.signatureVerified, checked.signatureTrusted);

const canvas = document.querySelector("#qr");
renderToCanvas(compressed, canvas, { mode: "print", imageSize: 720 });
const report = assessScanability(compressed, { imageSize: 480 });
console.log(report.score, report.rating);
```

Compression and signing use internal metadata only when required. There is no public content-type mode to configure. The private key signs, while the public verification key stays outside the QuadQR by default. Use the stored `keyId` to select an application-trusted public key. Scanability testing is deterministic synthetic regression testing and should be supplemented with real devices and print samples.

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
  cameraFinderRecoveryEvery: 2,
  async onResult(result) {
    console.log(result);
    scanner.stop();
  },
  onScanMiss() {
    // Keep searching.
  },
  onDiagnostic(event) {
    // Useful for live finder overlays and scanner debug logs.
    console.log(event.method, event.finderMethod, event.finderCount, event.geometry?.version);
  }
});
```

Camera access requires HTTPS or localhost. QuadQR scans the part of an `object-fit: cover` video that is actually visible to the user. The fast finder pass uses the RGB value channel (`max(R,G,B)`) so saturated data colors are less likely to be mistaken for structural black. After misses, throttled recovery frames can try alternate finder thresholds before stronger color correction. `onDiagnostic` exposes the finder method and geometry work already performed by the scanner.

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
<script src="https://cdn.jsdelivr.net/npm/quadqr-js@1.1.0/dist/quadqr.min.js"></script>
<script>
  const code = QuadQR.encodeText("Hello CDN");

  QuadQR.renderToCanvas(code, document.querySelector("#qr"), {
    imageSize: 720,
    quietZone: 4
  });
</script>
```

## unpkg

```html
<script src="https://unpkg.com/quadqr-js@1.1.0/dist/quadqr.min.js"></script>
```

## Direct CDN ESM

```html
<script type="module">
  import {
    encodeText,
    renderToCanvas
  } from "https://cdn.jsdelivr.net/npm/quadqr-js@1.1.0/dist/browser.js";

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

Pin a concrete package version such as `@1.1.0` in CDN URLs so an existing site does not silently change when a newer package version becomes available.
