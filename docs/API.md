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
  imageSize: 720,
  quietZone: 4,
  style: "classic",
  logo: {
    source: loadedImage,
    size: 0.12,
    clearBackground: true,
    padding: 0.65,
    radius: 0.8
  }
});
```

`imageSize` sets the exact square output width/height in pixels. The default is `720` when neither `imageSize` nor `moduleSize` is provided. `moduleSize` remains supported as a lower-level pixels-per-module sizing option and is used when `imageSize` is omitted.

`quietZone` is measured in modules. The default is `4`.

Logo options:

- `source`: loaded CanvasImageSource for canvas rendering, ImageData-like RGBA data for `renderToImageData()`, or URL/data URL for SVG.
- `size`: fraction of the matrix width/height, clamped to `0.05..0.30`. Default `0.18`.
- `clearBackground`: clears modules behind the logo using a solid background before drawing the logo.
- `padding`: clear-background padding in modules. Default `0.65`.
- `radius`: clear-background corner radius in modules. Default `0.8`.
- `backgroundColor`: background color when clearing. Defaults to palette white.

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

### `renderToSVG(codeOrMatrix, options?)`

Returns a standalone SVG string. It supports the same exact `imageSize`, palette, render style, quiet-zone, and logo geometry options as the browser canvas renderer. Because the preview/export is vector, it stays sharp when displayed above or below its nominal pixel size.

```js
const svg = renderToSVG(code, {
  imageSize: 720,
  quietZone: 6,
  style: "soft",
  logo: {
    source: "data:image/png;base64,...",
    size: 0.12,
    clearBackground: true
  }
});
```

## Image and camera scanning

### `scanImageData(imageData, options?)`

Scans an ImageData-like RGBA object. Clean frames use the normal observed-RGB path first. Difficult frames then get bounded fallback attempts using per-channel white balancing, spatial black/white normalization, tighter centre sampling, module-grid Auto Tone / Auto Contrast / Auto Color recovery, a rectified QR-region pixel enhancement pass, and sub-module geometry micro-refinement before the scan is rejected. Dense versions also use their distributed alignment markers to refine a noisy four-point projective solution when the initial alignment-grid score is plausible but imperfect. If exactly two strong finder patterns survive a steep angle, a bounded perspective-tolerant third-finder recovery pass is attempted before heavier color recovery.

```js
const result = scanImageData({
  width,
  height,
  data
});
```

Useful scanner options include `sampleRadius`, `robustSampleRadius`, `adaptiveSampling`, `spatialColorNormalization`, `autoEnhanceRecovery`, `rectifiedAutoEnhanceRecovery`, `rectifiedRecoveryModuleSize`, `autoEnhanceBlackClip`, `autoEnhanceWhiteClip`, `autoEnhanceSaturation`, `geometryRefinement`, `alignmentRefinement`, `alignmentRefinePatternThreshold`, `refinementOffset`, `structureTolerance`, and `maxErasureConfidence`. Auto enhancement and geometry refinement are enabled by default, but bounded recovery work only runs when the normal scan path or initial geometry needs it.

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

Starts live camera scanning. On browsers that expose camera controls, QuadQR requests continuous autofocus, exposure, and white balance. It scans the CSS-visible preview region by default. Finder detection uses a QuadQR-specific RGB value channel (`max(R,G,B)`) on the fast pass so saturated blue/red/green data cells are not mistaken for structural black. If a miss still contains at least two strong finder patterns, the scanner can retry the visible ROI at up to 1600 px before heavier recovery, which preserves more pixels per module for dense versions. If that does not decode, the **same captured frame** is retried through code-centric Auto Color recovery. The default recovery sequence crops 8%, 16%, and 22% from the camera-frame edges, then falls back to the full frame. This prevents dark room pixels, browser UI, or monitor bezels outside the guide from controlling Auto Color and Otsu thresholds. Each crop uses the Photoshop-style per-channel shadow/highlight correction with a neutral mid-high highlight target (190 by default). Finder-only recovery also tries multiple center-weighted Auto Color histogram windows before raw threshold bracketing. The normal fast path is untouched; these extra passes run only after a miss. If geometry is found but color decoding fails, the captured ROI is retried with the stronger color/geometry recovery, and consecutive failed frames can still be combined with confidence-weighted module voting.

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
  cameraHighResolutionRecovery: true,
  cameraHighResolutionMaxDimension: 1600,
  cameraHighResolutionEvery: 2,
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
  imageSize: 720,
  quietZone: 4
});
```

### `toSVG(codeOrMatrix, options?)`

Returns the standalone SVG string from the Node entry point.

### `saveSVG(codeOrMatrix, filename, options?)`

Writes SVG directly to disk.

```js
await saveSVG(code, "quadqr.svg", {
  imageSize: 720,
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
- `RENDER_MODES`
- `COMPRESSION_MODES`
- `SIGNATURE_ALGORITHMS`
- `STRESS_PROFILES`
- `ECC_LEVELS`

## Benchmark entry

Benchmark helpers are available from `quadqr-js/benchmark`:

```js
import {
  buildCapacityComparison,
  benchmarkCodec,
  calculateCapacityPlan
} from "quadqr-js/benchmark";
```

### `calculateCapacityPlan(options)`

Estimates the smallest QuadQR version for a byte count or concrete payload and reports remaining capacity plus the standard QR byte-mode version at the same nominal ECC letter. When only a byte count is known, compression gain is intentionally not guessed.

---

## Compression

### `encodeText(text, options?)` / `encodeBytes(input, options?)`

Both normal encoding APIs accept an optional compression mode:

```js
const code = QuadQR.encodeText("hello hello hello", {
  compression: "auto",
  ecc: "M"
});
```

`compression` may be `none`, `auto`, or `lz`.

- `none` stores the payload directly.
- `auto` compresses only when the result is meaningfully smaller. If compression does not help, no internal envelope is added.
- `lz` always stores the payload through QuadQR's portable LZ compressor.

There is no public content-type registry. Text remains text and byte arrays remain byte arrays.

### `compressPayload(input)` / `decompressPayload(input, expectedLength?)`

Portable synchronous LZSS-style compression helpers. They do not require Node zlib or browser `CompressionStream`.

## Binary convenience APIs

### `encodeUint8Array(input, options?)`

Explicit byte-oriented alias of `encodeBytes()`. It supports the same optional `compression` setting.

### `decodeUint8Array(matrix, options?)`

Decodes a matrix and returns only the application payload bytes.

## Signed QuadQR

### `generateSigningKeyPair()`

Generates an extractable Ed25519 key pair using Web Crypto and returns the CryptoKeys, raw public-key bytes, PKCS#8 private-key bytes, and a compact SHA-256-derived `keyId`.

### `encodeSignedText(text, options)` / `encodeSignedBytes(input, options)`

Signs the normal application payload with Ed25519. Any required signature and compression metadata is handled internally.

```js
const pair = await QuadQR.generateSigningKeyPair();
const code = await QuadQR.encodeSignedText("certificate payload", {
  ecc: "Q",
  compression: "auto",
  privateKey: pair.privateKey,
  keyId: pair.keyId
});
```

Only the private key is required for signing. `publicKey` is accepted only for the explicit `embedPublicKey: true` compatibility mode.

### `verifyDecodedSignature(result, options?)`

Verifies a signed decode result against a trusted external Ed25519 public key.

```js
const decoded = QuadQR.decodeMatrix(code.matrix);
const verified = await QuadQR.verifyDecodedSignature(decoded, {
  publicKey: knownPublicKey
});
```

For multiple issuers, pass a `trustedKeys` object or `Map` keyed by the embedded `keyId`:

```js
const verified = await QuadQR.verifyDecodedSignature(decoded, {
  trustedKeys: {
    [decoded.signingKeyId]: knownPublicKey
  }
});
```

`signatureVerified: true` means the signature is mathematically valid. `signatureTrusted: true` means it was checked using an external trusted key. `allowEmbeddedKey: true` may be used for compatibility/self-contained integrity checks, but such a result is not considered a trusted signer.

### Signing + encryption

`encodeSecureText()` and `encodeSecureBytes()` accept an optional `signing` object alongside `security` and `compression`. The internal pipeline is compression → signing → AES-256-GCM → Spectrum ECC.

```js
const code = await QuadQR.encodeSecureText("private signed payload", {
  compression: "auto",
  security: { mode: "password", password: "secret" },
  signing: {
    privateKey: pair.privateKey,
    keyId: pair.keyId
  }
});
```

## Print rendering

All render APIs accept:

```js
{ mode: "screen" | "print" }
```

Print mode uses a darker print-safe palette, forces Classic modules by default, and enforces a minimum 4-module quiet zone unless `allowUnsafePrintQuietZone: true` is explicitly set.

### `getPrintGuidance(codeOrMatrix, options?)`

Returns physical module size, pixels/module at a DPI, recommended minimum physical size, and print recommendations.

## Automatic logo safety

A logo can use:

```js
logo: {
  source: logo,
  size: "auto",
  clearBackground: true
}
```

`estimateSafeLogoSize()` exposes the conservative ratio used by auto mode. `findMaxSafeLogoSize()` performs an empirical binary search when the logo source is ImageData-like.

## Scanner confidence and debug mode

Normal successful scans now include:

- `confidence`
- `geometryConfidence`
- `calibrationConfidence`
- `structureConfidence`
- `eccUtilization`
- `correctedErrors`
- `diagnostics`

Use `scanImageData(image, { debug: true })` for detailed geometry/sampling information. `debugScanImageData()` is a non-throwing helper that returns `{ ok, result, debug }` or `{ ok: false, error, debug }`.

## Scanability and stress testing

### `applyStressDistortion(imageData, type, severity?)`

Deterministically applies a selected synthetic distortion.

### `runImageStressTest(imageData, expected?, options?)`

Runs the standard torture profiles and returns a 0–100 score plus per-scenario decode results.

### `assessScanability(code, renderOptions?, options?)`

Renders a code and runs the standard test suite. It returns `Excellent`, `Good`, `Risky`, or `Likely unscannable` together with recommendations.

Synthetic scores are regression aids and do not replace physical camera/print testing.
