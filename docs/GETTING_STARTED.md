# Getting Started

## Install

```bash
npm install quadqr-js
```

Node.js usage targets Node.js 20.19 or newer. Browser use works through a bundler, direct ESM, or the prebuilt CDN/global bundle.

## Encode and decode text

```js
import { encodeText, decodeMatrix } from "quadqr-js";

const code = encodeText("Hello from QuadQR", {
  ecc: "M"
});

const result = decodeMatrix(code.matrix);
console.log(result.text);
```

If no version is supplied, QuadQR automatically chooses the smallest version that fits the payload.

## Render in the browser

```js
import {
  encodeText,
  renderToCanvas,
  renderToSVG
} from "quadqr-js/browser";

const code = encodeText("Rendered in the browser");

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

Available presentation styles are `classic`, `depth`, `soft`, and `inset`. Styling does not change the encoded matrix.

`imageSize` is the exact square output dimension in pixels. If you omit both `imageSize` and `moduleSize`, the renderer defaults to 720 × 720 px. `moduleSize` is still available for low-level pixels-per-module sizing.

To add a centered logo, load it as an `Image` and pass it as `logo.source`. Transparent logo pixels remain transparent. Use `clearBackground: true` when you want a padded white area behind the logo. `quietZone` is measured in modules and defaults to `4`.

## Scan an uploaded image

```js
import { scanFile } from "quadqr-js/browser";

const file = document.querySelector("#image").files[0];
const result = await scanFile(file);

console.log(result.text);
```

## Scan from the camera

```js
import { startCameraScanner } from "quadqr-js/browser";

let scanner;
scanner = await startCameraScanner(
  document.querySelector("#video"),
  {
    cameraFinderRecoveryEvery: 2,
    onResult(result) {
      console.log(result);
      scanner.stop();
    }
  }
);
```

Camera access requires HTTPS or localhost. Finder detection uses a QuadQR-specific RGB value pass first, then throttled threshold recovery when the fast pass cannot lock onto all three finder patterns.

## Secure password mode

Secure payloads are optional. Password mode is the simplest choice when a person will provide the secret during decryption.

```js
import {
  encodeSecureText,
  decodeMatrix,
  decryptDecoded
} from "quadqr-js";

const code = await encodeSecureText("Private payload", {
  ecc: "M",
  security: {
    mode: "password",
    password: "correct horse battery staple"
  }
});

const locked = decodeMatrix(code.matrix);

const unlocked = await decryptDecoded(locked, {
  password: "correct horse battery staple"
});

console.log(unlocked.text);
```

A secure image or camera scan follows the same pattern: scanning returns a locked result, then `decryptDecoded()` reveals plaintext only after successful authentication.

## Secure raw-key mode

Use raw-key mode when an application already manages its own cryptographic keys.

```js
import {
  encodeSecureText,
  generateRaw256Key
} from "quadqr-js";

const key = generateRaw256Key();

const code = await encodeSecureText("Application-managed secret", {
  security: {
    mode: "raw-key",
    key
  }
});
```

The key must be exactly 32 bytes. Never embed the secret key inside the same QuadQR payload.

## Generate PNG and SVG files in Node.js

```js
import { encodeText } from "quadqr-js";
import { savePNG, saveSVG, scanFile } from "quadqr-js/node";

const code = encodeText("Generated on Node.js");

await savePNG(code, "quadqr.png", {
  imageSize: 720,
  quietZone: 4
});

await saveSVG(code, "quadqr.svg", {
  imageSize: 720,
  quietZone: 4
});

const result = await scanFile("quadqr.png");
console.log(result.text);
```

PNG generation/decoding and SVG generation are built into the Node.js adapter.

## Use a script tag

```html
<canvas id="qr"></canvas>
<script src="https://cdn.jsdelivr.net/npm/quadqr-js@1.0.1/dist/quadqr.min.js"></script>
<script>
  const code = QuadQR.encodeText("No build step");
  QuadQR.renderToCanvas(code, document.querySelector("#qr"));
</script>
```

Pin an exact package version in production.

## Use the CLI

```bash
npx quadqr-js encode "Hello QuadQR" -o hello.png
npx quadqr-js decode hello.png
```

Password-protected CLI workflow:

```bash
npx quadqr-js encode "Private data" --password "my-password" -o secure.png
npx quadqr-js decode secure.png --password "my-password"
```

See [CLI.md](./CLI.md) for the full command reference.
