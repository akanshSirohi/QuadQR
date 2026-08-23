# Node.js

QuadQR uses the same matrix codec and scanner core in Node.js and the browser. The `quadqr-js/node` entry adds Node-specific PNG, file, and buffer helpers.

## Requirements

Node.js 20.19 or newer.

## ESM

```js
import { encodeText } from "quadqr-js";
import { savePNG, saveSVG, scanFile } from "quadqr-js/node";
```

## CommonJS

```js
const QuadQR = require("quadqr-js");
const QuadQRNode = require("quadqr-js/node");
```

## Generate a PNG

```js
const code = QuadQR.encodeText("Server generated");

await QuadQRNode.savePNG(code, "output.png", {
  imageSize: 720,
  quietZone: 4
});
```

## Generate an SVG

```js
await QuadQRNode.saveSVG(code, "output.svg", {
  imageSize: 720,
  quietZone: 4,
  style: "classic"
});
```

`imageSize` is the exact PNG/SVG output dimension in pixels. If you omit both `imageSize` and `moduleSize`, rendering defaults to 720 × 720 px. `moduleSize` remains available for legacy pixels-per-module sizing.

Use `toSVG()` when you need the SVG string in memory. SVG logo sources can be URL/data URL strings. For PNG generation with a logo through `renderToImageData()`, pass decoded ImageData-like RGBA pixels as the logo source.

Use `toPNG()` when you need an in-memory `Buffer`:

```js
const png = QuadQRNode.toPNG(code);
```

This works well for HTTP responses, object storage, attachments, and other buffer-based workflows.

## Scan a PNG file

```js
const result = await QuadQRNode.scanFile("output.png");
console.log(result.text);
```

Or scan a buffer:

```js
const result = await QuadQRNode.scanBuffer(pngBuffer);
```

PNG generation and decoding do not require external native dependencies.

## Other image formats

For JPEG, WebP, or AVIF input, the Node adapter can use `sharp` when the consuming application has it installed:

```bash
npm install sharp
```

If `sharp` is not installed, decode the image to RGBA in your own image pipeline and pass the pixels to `scanImageData()`.

## Secure password workflow

```js
import {
  decryptDecoded,
  encodeSecureText
} from "quadqr-js";
import {
  savePNG,
  scanFile
} from "quadqr-js/node";

const code = await encodeSecureText("private", {
  security: {
    mode: "password",
    password: process.env.QUADQR_PASSWORD
  }
});

await savePNG(code, "secure.png");

const locked = await scanFile("secure.png");

const unlocked = await decryptDecoded(locked, {
  password: process.env.QUADQR_PASSWORD
});

console.log(unlocked.text);
```

## Secure raw-key workflow

```js
import {
  decryptDecoded,
  encodeSecureText,
  generateRaw256Key
} from "quadqr-js";
import { toPNG, scanBuffer } from "quadqr-js/node";

const key = generateRaw256Key();

const code = await encodeSecureText("machine secret", {
  security: {
    mode: "raw-key",
    key
  }
});

const png = toPNG(code);
const locked = await scanBuffer(png);
const unlocked = await decryptDecoded(locked, { key });

console.log(unlocked.text);
```

Keep long-lived application keys in an appropriate secret-management or platform key-storage system.
