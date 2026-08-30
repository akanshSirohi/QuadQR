# API Reference

## Core encoding

### `encodeText(text, options?)`

Synchronously encodes UTF-8 text.

```js
import { encodeText } from "quadqr-js";

const code = encodeText("Hello", {
  ecc: "M",
  version: 5,
  highDensity: true // optional experimental 4-bit cells
});
```

If `version` is omitted, QuadQR selects the smallest version that fits.

`highDensity` is a boolean. It defaults to `false`. Set `highDensity: true` to enable the experimental Triangle16 layout with two RGBW triangles, 16 states, and 4 raw bits per body cell. The protected header remains solid-color in High Density Mode. Image and camera scanners auto-detect it.

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

Scans an ImageData-like RGBA object. The scanner automatically attempts both normal RGBW center sampling and Triangle16 dual-region sampling when geometry is found. When normal projective geometry is locatable but too coarse for half-cell Triangle16 regions, one bounded precise-alignment recovery pass refines the alignment center at sub-module resolution. Clean frames use the normal observed-RGB path first. Difficult frames then get bounded fallback attempts using per-channel white balancing, spatial black/white normalization, tighter centre sampling, QuadQR module-grid Auto Tone / Auto Contrast / Auto Color recovery, a rectified QR-region pixel enhancement pass, and sub-module geometry micro-refinement before the scan is rejected. Dense versions also use their distributed alignment markers to refine a noisy four-point projective solution when the initial alignment-grid score is plausible but imperfect. If exactly two strong finder patterns survive a steep angle, a bounded perspective-tolerant third-finder recovery pass is attempted before heavier color recovery.

```js
const result = scanImageData({
  width,
  height,
  data
});
```

Useful scanner options include `sampleRadius`, `robustSampleRadius`, `adaptiveSampling`, `spatialColorNormalization`, `autoEnhanceRecovery`, `rectifiedAutoEnhanceRecovery`, `rectifiedRecoveryModuleSize`, `geometryRefinement`, `alignmentRefinement`, `structureTolerance`, `maxErasureConfidence`, `softDecoding`, `softDecodeConfidence`, `softDecodeMaxCells`, and `softDecodePairCells`. Spectrum ECC 2.0 soft decoding is bounded and only runs after ordinary hard/error-erasure decoding fails.

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

Starts live camera scanning. On browsers that expose camera controls, QuadQR requests continuous autofocus, exposure, and white balance. Modern browsers use two module Web Workers by default: a **fast fresh-frame worker** for normal finder/geometry/decode attempts and a separate **full-recovery worker** for the same perspective, color, high-resolution, ECC, damaged-code, and multi-frame recovery stack used by the main scanner. The recovery worker is lazy and independent, so a difficult old frame cannot block the fast worker from inspecting a newer camera frame. Finder detection itself is JavaScript; WASM only accelerates deterministic grayscale/binary preprocessing and CRC. The loop uses `requestVideoFrameCallback()` when available, drops stale fast-path frames, and measures `scanInterval` from scan start. Worker mode defaults to a 33 ms minimum cadence; automatic main-thread fallback uses 80 ms. The default camera request is approximately 1280×720, while the CSS-visible preview crop is resized to a 640 px working bitmap before crossing the worker boundary. Finder acquisition uses the streaming 1:1:3:1:1 RGB-value pass, direct cross-checks, local-threshold fallback, and directional module-size/version estimation. Once a geometry candidate validates structure, ECC, and CRC, it returns immediately. A miss with strong finder evidence dispatches parallel full recovery quickly; frames with weak or zero finder evidence still receive periodic full recovery so color-cast/damaged locator cases remain recoverable. That recovery can use up to 960 px and retains the full QuadQR Auto Color crop sequence, center-weighted color recovery, threshold bracketing, precise alignment, perspective recovery, affine cross-channel calibration, QR-region enhancement, multi-frame confidence fusion, erasure decoding, and soft-decision Spectrum ECC.

```js
const scanner = await startCameraScanner(video, {
  cameraWorker: true,
  maxDimension: 640,
  scanInterval: 33,
  useVideoFrameCallback: true,
  cameraGeometryReuse: true,
  cameraGeometryReuseMaxMisses: 5,
  multiFrame: true,
  multiFrameWindow: 4,
  multiFrameMinFrames: 2,
  softDecoding: true,
  cameraAutoColorEvery: 1,
  cameraAutoColorCropInsets: [0.08, 0.16, 0.22, 0],
  cameraAutoColorHighlightPercentile: 0.95,
  cameraAutoColorOutputHighlight: 190,
  cameraAutoColorAnalysisInset: 0.10,
  cameraAutoEnhanceEvery: 2,
  cameraFinderRecoveryEvery: 2,
  cameraHighResolutionRecovery: true,
  cameraHighResolutionMaxDimension: 960,
  cameraHighResolutionEvery: 2,
  cameraRecoveryStrongFinderInterval: 120,
  cameraRecoveryWeakFinderInterval: 260,
  cameraRecoveryNoFinderInterval: 850,
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

Loads and activates the optional bundled WASM accelerator for CRC-32 and scanner pixel preprocessing (RGBA grayscale conversion, Otsu thresholding, and finder binary generation).

```js
import { initWasm } from "quadqr-js";
await initWasm();
```

An explicit URL or byte buffer can also be supplied. Initialize it once before performance-sensitive synchronous `scanImageData()` loops or before starting the camera scanner.

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

`compression` may be `none`, `auto`, `smart`, `brotli`, `deflate`, or `lz`.

- `none` stores the payload directly.
- `auto` is the fast balanced mode: one pass each of LZ level 6, DEFLATE level 6, and Brotli quality 6, followed by a complete stored-size comparison including envelope overhead.
- `smart` is the CPU-heavy mode. It starts with the Auto pass, checks the resulting QuadQR version, and only escalates to DEFLATE 8 / Brotli 9 and then DEFLATE 9 / Brotli 11 when a smaller physical version is realistically reachable.
- `brotli` always stores the payload using QuadQR's bundled synchronous Brotli codec.
- `deflate` always stores the payload using QuadQR's synchronous pure-JavaScript raw DEFLATE codec.
- `lz` always stores the payload through the original portable LZSS-style compressor for backward compatibility.

Explicit LZ, DEFLATE, and Brotli support `compressionLevel`:

```js
encodeText(text, { compression: "lz", compressionLevel: 9 }); // 1..9, default 6
encodeText(text, { compression: "deflate", compressionLevel: 9 }); // 1..9, default 6
encodeText(text, { compression: "brotli", compressionLevel: 11 }); // 0..11, default 11
```

`lzLevel`, `deflateLevel`, and `brotliQuality` are accepted as algorithm-specific aliases. Levels affect encoder effort only and are not serialized because the decoder does not need them. Generated code objects expose `compressionLevel`, `compressionStrategy`, and Smart-mode diagnostics; scanned symbols only need the stored compression algorithm ID.

There is no public content-type registry. Text remains text and byte arrays remain byte arrays.

### `compressPayload(input, options?)` / `decompressPayload(input, expectedLength?)`

Legacy portable synchronous LZSS-style compression helpers. `options.level` accepts integers `1..9` and defaults to 6. Higher levels walk deeper candidate history and may use bounded lazy matching; level 6 preserves the historical QuadQR search depth. The LZ wire format and decoder are unchanged at every level.

### `compressDeflatePayload(input, options?)` / `decompressDeflatePayload(input, expectedLength?)`

Raw-DEFLATE helpers. `options.level` accepts integers `1..9` and defaults to 6. Higher levels spend more CPU on deeper LZ77 candidate search and lazy matching. The compressor emits standard RFC 1951 fixed-Huffman blocks with a 32 KiB match window and matches up to 258 bytes. The implementation is pure JavaScript and synchronous, so the same core works in browsers, Node.js servers, workers, and other JavaScript runtimes without `node:zlib`, `CompressionStream`, DOM APIs, or native dependencies.

### `compressBrotliPayload(input, options?)` / `decompressBrotliPayload(input, expectedLength?)`

Bundled synchronous Brotli helpers. `compressBrotliPayload()` accepts an optional `{ quality }` setting from 0 through 11 for direct codec use. The generated stream is standard Brotli and the decoder accepts standard Brotli streams. QuadQR does not require `node:zlib`, browser `CompressionStream`, DOM APIs, a native addon, or a runtime dependency for this path.

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

### `applyStressDistortion(imageData, type, severity?, options?)`

Deterministically applies a selected synthetic distortion. In addition to the original blur/exposure/shadow/resampling profiles, `perspective-3d` accepts `pitchDegrees`, `yawDegrees`, and `rollDegrees` for camera-angle testing.

### `runImageStressTest(imageData, expected?, options?)`

Runs the standard torture profiles and returns a 0–100 score plus per-scenario decode results.

### `assessScanability(code, renderOptions?, options?)`

Renders a code and runs the standard test suite. It returns `Excellent`, `Good`, `Risky`, or `Likely unscannable` together with recommendations.

### `runReliabilityLab(imageData, expected?, options?)`

Runs the broader Reliability Lab suite. `options.suite` can be `quick`, `full`, or `extreme`. Results include overall score, per-scenario CRC verification, category scores, confidence, RS corrections, and timing.

### `runPerspectiveSweep(imageData, expected?, options?)`

Sweeps `yaw`, `pitch`, or `roll`/Z rotation across a list of angles and reports the largest tested angle that decoded successfully.

Synthetic scores are regression aids and do not replace physical camera/print testing. See [`RELIABILITY_LAB.md`](./RELIABILITY_LAB.md).
