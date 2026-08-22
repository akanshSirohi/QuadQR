# API Reference

## Core encoding

### `encodeText(text, options?)`

Synchronously encodes UTF-8 text.

```js
import { encodeText } from "quadqr-js";

const code = encodeText("Hello", {
  ecc: "M",
  version: 5
});
```

If `version` is omitted, QuadQR selects the smallest version that fits.

### `encodeBytes(bytes, options?)`

Encodes arbitrary bytes.

```js
const code = encodeBytes(
  new Uint8Array([1, 2, 3, 4]),
  { ecc: "Q" }
);
```

## Secure encoding

### `encodeSecureText(text, options)`

Encrypts text using Secure Payload v1 and encodes the encrypted envelope.

Password mode:

```js
const code = await encodeSecureText("secret", {
  security: {
    mode: "password",
    password: "example-password"
  }
});
```

Raw-key mode:

```js
const code = await encodeSecureText("secret", {
  security: {
    mode: "raw-key",
    key
  }
});
```

### `encodeSecureBytes(bytes, options)`

Byte-oriented equivalent of `encodeSecureText()`.

### `decryptDecoded(result, credentials)`

Unlocks a secure result returned by matrix, image, camera, or Node.js scanning.

```js
const unlocked = await decryptDecoded(locked, {
  password: "example-password"
});
```

For raw-key mode:

```js
const unlocked = await decryptDecoded(locked, { key });
```

## Matrix decoding

### `decodeMatrix(matrix, options?)`

Decodes an already sampled QuadQR matrix.

```js
const result = decodeMatrix(code.matrix);
console.log(result.text);
```

A secure result remains locked until it is decrypted:

```js
{
  secure: true,
  requiresDecryption: true,
  text: null,
  payload: Uint8Array(...),
  security: {
    mode: "password",
    algorithm: "AES-256-GCM"
  }
}
```

## Rendering

### `renderToCanvas(codeOrMatrix, canvas, options?)`

Renders to an HTML canvas.

```js
renderToCanvas(code, canvas, {
  moduleSize: 12,
  quietZone: 4,
  style: "classic"
});
```

Supported styles:

- `classic`
- `depth`
- `soft`
- `inset`

### `renderToImageData(codeOrMatrix, options?)`

Returns runtime-neutral RGBA pixels:

```js
{
  width,
  height,
  data: Uint8ClampedArray
}
```

## Image and camera scanning

### `scanImageData(imageData, options?)`

Scans an ImageData-like RGBA object. Clean frames use the normal observed-RGB path first. Difficult frames then get bounded fallback attempts using per-channel white balancing, spatial black/white normalization, tighter centre sampling, module-grid Auto Tone / Auto Contrast / Auto Color recovery, a rectified QR-region pixel enhancement pass, and sub-module geometry micro-refinement before the scan is rejected.

```js
const result = scanImageData({
  width,
  height,
  data
});
```

Useful scanner options include `sampleRadius`, `robustSampleRadius`, `adaptiveSampling`, `spatialColorNormalization`, `autoEnhanceRecovery`, `rectifiedAutoEnhanceRecovery`, `rectifiedRecoveryModuleSize`, `autoEnhanceBlackClip`, `autoEnhanceWhiteClip`, `autoEnhanceSaturation`, `geometryRefinement`, `refinementOffset`, `structureTolerance`, and `maxErasureConfidence`. Auto enhancement and geometry refinement are enabled by default, but only run after the normal scan path fails.

### Browser `scanFile(file, options?)`

Available from `quadqr-js/browser` and the browser-compatible main entry. Accepts a browser `File` or `Blob`.

```js
const result = await scanFile(file);
```

### `scanVideoFrame(video, options?)`

Scans the current frame from an HTML video element. With the default `videoCropMode: "visible"`, an `object-fit: cover` preview is mapped back to the matching source crop before scanning, so hidden sensor pixels do not shrink the code or skew enhancement statistics.

```js
const result = scanVideoFrame(video);
```

### `startCameraScanner(video, options?)`

Starts live camera scanning. On browsers that expose camera controls, QuadQR requests continuous autofocus, exposure, and white balance. It scans the CSS-visible preview region by default. Finder detection uses a QuadQR-specific RGB value channel (`max(R,G,B)`) on the fast pass so saturated blue/red/green data cells are not mistaken for structural black. If that fast pass fails, the **same captured frame** is retried through code-centric Auto Color recovery before finder detection. The default recovery sequence crops 8%, 16%, and 22% from the camera-frame edges, then falls back to the full frame. This prevents dark room pixels, browser UI, or monitor bezels outside the guide from controlling Auto Color and Otsu thresholds. Each crop uses the Photoshop-style per-channel shadow/highlight correction with a neutral mid-high highlight target (190 by default). Finder-only recovery also tries multiple center-weighted Auto Color histogram windows before raw threshold bracketing. The normal fast path is untouched; these extra passes run only after a miss. If geometry is found but color decoding fails, the captured ROI is retried with the stronger color/geometry recovery, and consecutive failed frames can still be combined with confidence-weighted module voting.

```js
const scanner = await startCameraScanner(video, {
  scanInterval: 120,
  multiFrame: true,
  multiFrameWindow: 4,
  cameraAutoColorEvery: 1,
  cameraAutoColorCropInsets: [0.08, 0.16, 0.22, 0],
  cameraAutoColorHighlightPercentile: 0.95,
  cameraAutoColorOutputHighlight: 190,
  cameraAutoColorAnalysisInset: 0.10,
  cameraAutoEnhanceEvery: 2,
  cameraFinderRecoveryEvery: 2,
  onResult(result) {
    console.log(result);
  },
  onScanMiss() {
    // Keep searching.
  },
  onDiagnostic(event) {
    // Finder positions are in the scanner frame coordinate space.
    // Use scanWidth/scanHeight to map them onto a video overlay.
    if (event.type === "frame") {
      console.log(event.method, event.finderCount, event.geometry?.version, event.elapsedMs);
    }
  }
});

scanner.stop();
```

`onDiagnostic` is opt-in. It reports finder candidates, the locator method (`rgb-value-otsu`, threshold-bracket recovery, or luminance fallback), geometry data, and recovery state. Diagnostics reuse the scanner's existing passes and do not add a separate finder scan.

### `rectifyDetectedCode(imageData, options?)`

Returns the perspective-corrected detected symbol image when detection succeeds.

### `rotateMatrix(matrix, quarterTurns?)`

Rotates a matrix by 90-degree quarter turns.

## Node.js helpers

Import from `quadqr-js/node`.

### `toPNG(codeOrMatrix, options?)`

Returns a Node.js `Buffer` containing a PNG.

### `savePNG(codeOrMatrix, filename, options?)`

Writes a PNG file.

```js
await savePNG(code, "quadqr.png", {
  moduleSize: 12,
  quietZone: 4
});
```

### `scanBuffer(buffer, options?)`

Scans an image buffer. PNG is supported without dependencies. Other formats can use the host application's optional `sharp` installation.

### Node `scanFile(filename, options?)`

Reads and scans an image file.

### `decodePNG(buffer)`

Decodes supported PNG data into RGBA pixels.

### `encodePNG(imageData, options?)`

Encodes RGBA pixels into a PNG `Buffer`.

## Security utilities

### `generateRaw256Key()`

Generates a cryptographically random 32-byte key.

### `normalizeRaw256Key(key)`

Normalizes a 32-byte key supplied as bytes, ArrayBuffer, or 64-character hexadecimal text.

### `bytesToHex(bytes)`

Converts bytes to lowercase hexadecimal text.

Security constants include:

- `SECURITY_MODES`
- `SECURITY_ALGORITHMS`
- `SECURE_PAYLOAD_VERSION`
- `DEFAULT_PBKDF2_ITERATIONS`

## WASM

### `initWasm(options?)`

Loads and activates the optional bundled WASM accelerator.

```js
import { initWasm } from "quadqr-js";
await initWasm();
```

An explicit URL or byte buffer can also be supplied.

### `getWasmState()`

Returns the active WASM state or `null`.

### `disableWasm()`

Returns the codec to the JavaScript implementation.

## Version and capacity

### `getVersionInfo(version, options?)`

Returns geometry and payload information for a specific QuadQR version/ECC profile.

## CRC utilities

### `crc32(bytes)`

Calculates QuadQR's CRC-32 value for a byte array.

### `installCrc32Accelerator(accelerator?)`

Installs or removes a synchronous CRC-32 accelerator. Most applications should use `initWasm()` rather than calling this directly.

## Constants

Common exported constants include:

- `FORMAT_VERSION`
- `MIN_VERSION`
- `MAX_VERSION`
- `DEFAULT_ECC_LEVEL`
- `CELL`
- `DEFAULT_PALETTE`
- `RENDER_STYLES`
- `ECC_LEVELS`

## Benchmark entry

Benchmark helpers are available from `quadqr-js/benchmark`:

```js
import {
  buildCapacityComparison,
  benchmarkCodec
} from "quadqr-js/benchmark";
```
