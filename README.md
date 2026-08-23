# QuadQR (QQR)

<p align="center">
  <img src="assets/banner.png?raw=true" alt="QuadQR banner">
</p>

<p align="center">
  <strong>Four visible states. Two bits per data cell. A modern experiment in high-density matrix codes.</strong>
</p>

<p align="center">
  <a href="https://akanshsirohi.github.io/QuadQR/demo/"><strong>Try the Live Demo</strong></a>
  ·
  <a href="https://akanshsirohi.github.io/QuadQR/docs-site/"><strong>Documentation Site</strong></a>
  ·
  <a href="https://www.npmjs.com/package/quadqr-js">npm</a>
  ·
  <a href="#current-benchmark">Benchmark</a>
  ·
  <a href="#getting-started">Use the Library</a>
  ·
  <a href="docs/README.md">Markdown Docs</a>
  ·
  <a href="FORMAT.md">Format Specification</a>
</p>

**QuadQR** is an experimental open-source 2D matrix code that uses four visible data states instead of the two states used by a traditional black-and-white QR module.

Each QuadQR data cell represents exactly **2 bits**:

| Color | Bits |
|---|---|
| Red | `00` |
| Green | `01` |
| Blue | `10` |
| White | `11` |

That gives QuadQR a four-symbol alphabet and a raw density of **2 bits per data cell**.

QuadQR keeps the parts that make QR-like codes practical, such as a square matrix, finder patterns, timing structures, error correction, masking, perspective recovery, and camera scanning, while experimenting with a higher-density color-based data layer.

> **Important:** QuadQR is an experimental custom format. It is **not ISO QR Code**, and normal QR scanner apps cannot decode it.

## Examples

Below are QuadQR symbols generated with different error-correction profiles. They use the same four-state RGBW data alphabet while varying the amount of space dedicated to Reed-Solomon protection.

<table>
  <tr>
    <td align="center">
      <img src="assets/quadqr-v2-L.png?raw=true" alt="QuadQR example using ECC profile L" width="320"><br>
      <sub><strong>ECC L</strong> · Higher payload capacity</sub>
    </td>
    <td align="center">
      <img src="assets/quadqr-v2-M.png?raw=true" alt="QuadQR example using ECC profile M" width="320"><br>
      <sub><strong>ECC M</strong> · More error-correction redundancy</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="https://akanshsirohi.github.io/QuadQR/demo/"><strong>Generate, scan, and benchmark QuadQR in your browser →</strong></a>
</p>

---

## Why I built QuadQR

I have always found QR codes fascinating. They are compact, practical, extremely well optimized, and they have continued to work reliably for decades.

But one thing caught my attention: the basic visual data representation is still binary. A module is essentially one of two states, black or white, representing `0` or `1`.

That made me wonder:

> If modern cameras, displays, image processing, and computing are much more capable today, can a QR-like matrix code reliably use more than two visible states and store more information in the same area?

I started researching the idea and working through the math. Four reliably distinguishable states are especially interesting because:

```text
log2(4) = 2 bits
```

So a four-state module can represent exactly two bits without requiring fractional-bit packing.

That eventually became QuadQR.

The current format uses **Red, Green, Blue, and White**, giving every data cell four possible states while keeping a square module grid that is easy to generate, sample, correct for perspective, and scan.

This project is an experiment in exploring how far a QR-inspired design can be pushed with modern hardware and software.

### Development note

I designed the format, researched the approach, iterated on the encoding structure, and built the project as an independent experiment. **OpenAI Codex** helped significantly with some of the more complex implementation work, including parts of the codec, error correction, image-processing logic, testing, and optimization.

---

## What makes QuadQR different?

A traditional QR data module has two possible states:

```text
Black
White
```

That gives:

```text
log2(2) = 1 bit per module
```

QuadQR uses four data states:

```text
Red
Green
Blue
White
```

That gives:

```text
log2(4) = 2 bits per data cell
```

So at the raw data-cell level:

| Format | States per data cell | Raw information |
|---|---:|---:|
| Binary QR | 2 | 1 bit |
| QuadQR | 4 | 2 bits |

This is a **2× raw symbol-density advantage**.

### Spectrum ECC: QuadQR-specific reliability without capacity loss

QuadQR now uses a second idea that is possible because the scanner already measures calibrated color rather than only black/white state: **confidence-aware Reed-Solomon recovery**.

For every sampled RGBW data module, the scanner keeps both the selected state and a confidence score based on the distance to the nearest and second-nearest calibrated color states. Four module confidences are combined into the confidence of their GF(256) byte symbol.

If normal hard-decision Reed-Solomon decoding fails, the least-confident byte symbols can be promoted to **known erasures**. Reed-Solomon can spend parity more efficiently on known erasure locations than on completely unknown errors. CRC-32 remains the final acceptance check.

QuadQR also applies a deterministic **spectral-spatial interleaver** after ECC. Neighboring logical codeword cells are scattered across distant physical data positions, so a scratch, glare patch, shadow, or localized print defect tends to affect many different RS symbols instead of destroying a contiguous run. The permutation is reversible and consumes **zero extra data cells**.

These features do **not** change the RGBW alphabet, module count, ECC parity count, or payload-capacity calculation. They improve how the existing redundancy is used.

However, raw cell density is not the same thing as final user-payload capacity. Finder patterns, timing structures, calibration cells, headers, CRC, masking, error correction, and other reserved cells all consume space.

That is why QuadQR includes its own benchmark instead of assuming that every completed symbol will contain exactly twice the payload of a standard QR code.

---

## Secure Payload v1

QuadQR now includes an **optional authenticated-encryption layer**. It sits above the matrix codec, so normal QuadQR symbols keep the same RGBW mapping, Spectrum ECC, scanner, and capacity behavior.

Two security modes are supported:

| Mode | Key source | Best suited for |
|---|---|---|
| Password | PBKDF2-HMAC-SHA-256 derives a 256-bit key from a password | Human-to-human protected payloads |
| Raw 256-bit key | Exact 32-byte random key supplied by the application | Apps, tickets, provisioning, enterprise scanners |

Both modes use **AES-256-GCM**, which provides encryption and authentication. A wrong password/key or modified encrypted payload fails decryption instead of returning silent garbage.

Password mode currently defaults to **600,000 PBKDF2-HMAC-SHA-256 iterations** with a random 16-byte salt. Raw-key mode avoids password-KDF work and automatically stores an 8-byte SHA-256 key fingerprint as a non-secret key ID unless disabled or overridden. The actual raw key is never embedded in the symbol.

The security envelope is versioned independently from the QuadQR matrix format so a future release can add another KDF or encryption mode without redesigning the RGBW/ECC layer.

Security is intentionally opt-in. Unencrypted codes remain the default.

The browser demo supports secure scanning in **both scanner paths**:

- **Image scanner:** upload/exported images and photographs are decoded normally; secure symbols are detected automatically and show the matching password or raw-key decrypt control inline.
- **Camera scanner:** live camera frames use the same secure-aware decode path. When an encrypted symbol is verified, scanning stops, the result is marked **Secure QR**, and plaintext is revealed only after successful authenticated decryption.

The scanner never expects the secret to be embedded in the QuadQR itself. Raw-key symbols expose only their non-secret key ID/fingerprint.

---

## Current benchmark

Run:

```bash
npm run benchmark
```

The benchmark compares QuadQR with standard QR **at the same matrix dimensions** using byte-mode QR reference capacities.

Current representative results at the project's `M` ECC profile:

| Version | Matrix | QuadQR payload | Standard QR payload | Gain | Ratio |
|---:|---:|---:|---:|---:|---:|
| 1 | 21×21 | **24 B** | 14 B | +10 B | **1.71×** |
| 2 | 25×25 | **48 B** | 26 B | +22 B | **1.85×** |
| 5 | 37×37 | **227 B** | 84 B | +143 B | **2.70×** |
| 10 | 57×57 | **630 B** | 213 B | +417 B | **2.96×** |
| 20 | 97×97 | **1992 B** | 666 B | +1326 B | **2.99×** |
| 30 | 137×137 | **4054 B** | 1370 B | +2684 B | **2.96×** |
| 40 | 177×177 | **6858 B** | 2331 B | +4527 B | **2.94×** |

### How to read this table

For example:

```text
Version 10
Matrix: 57×57

QuadQR:      630 bytes
Standard QR: 213 bytes

Gain:        417 bytes
Ratio:       2.96×
```

This means that under the benchmark's current assumptions, a 57×57 QuadQR symbol can carry 630 user-payload bytes, while the standard QR byte-mode reference at the same dimensions and `M` label carries 213 bytes.

### Important benchmark warning

The letters `L`, `M`, `Q`, and `H` in QuadQR are **project-defined ECC profiles**.

They do **not** currently claim the same standardized recovery percentages as ISO QR Code ECC levels with the same letters.

Therefore:

> The capacity benchmark is a same-dimension and same-label comparison, not yet an equal-damage-tolerance comparison.

The raw QuadQR data alphabet is exactly **2 bits per data cell**. Ratios approaching ~3× in the current usable-payload benchmark are caused by differences in total structural and ECC overhead between the two formats, not because a QuadQR cell contains 3 bits.

A future goal is to add **equal-reliability benchmarking**, where QuadQR and standard QR are compared after calibrating both to similar real-world damage recovery.

---

## Performance benchmark

The benchmark also measures direct codec performance.

It reports:

- payload size;
- automatically selected version;
- matrix dimensions;
- mean encode time;
- 95th percentile encode time;
- mean decode time;
- 95th percentile decode time.

Example output:

```text
payload_B   matrix    version   encode_mean   encode_p95   decode_mean   decode_p95
24          21x21     v1        ...
128         33x33     v4        ...
512         53x53     v9        ...
1024        73x73     v14       ...
2048        101x101   v21       ...
```

These timings measure the **matrix codec**, not the complete camera-scanning pipeline.

Camera scanning additionally includes finder detection, perspective correction, calibration, module sampling, and color classification.

For more stable local timing results, use more iterations:

```bash
npm run benchmark -- --iterations=500
```

For machine-readable results:

```bash
npm run --silent benchmark -- --json
```

---

## Version 1 optimization

Small symbols have a difficult tradeoff because fixed metadata and ECC consume a much larger fraction of the matrix.

The original 21×21 QuadQR design could not fit a valid `M` payload because the protected framing itself was larger than the available data area.

Version 1 now uses a dedicated compact small-symbol profile.

At `M`:

```text
21×21 QuadQR
24 bytes user payload
```

compared with:

```text
21×21 standard QR reference
14 bytes byte-mode payload
```

Version 2 and above continue to use the normal framing and ECC structure.

---

## Encoding pipeline

The current QuadQR pipeline is:

```text
payload bytes
  ↓
optional Secure Payload v1 (AES-256-GCM)
  ↓
header + CRC-32
  ↓
GF(256) Reed-Solomon error correction
  ↓
interleaved byte codewords
  ↓
split every encoded byte into four 2-bit values
  ↓
zero-overhead spectral-spatial permutation
  ↓
00 / 01 / 10 / 11
  ↓
Red / Green / Blue / White
  ↓
quaternary masking at physical positions
  ↓
square QuadQR matrix
```

Because four states map naturally to two bits, QuadQR does not require base-3 conversion or fractional-bit packing.

One encoded byte maps naturally to four data cells:

```text
8 bits ÷ 2 bits/cell = 4 cells
```

---

## Symbol structure

QuadQR currently uses:

- a square overall symbol;
- square modules;
- three 7×7 black-and-white finder patterns;
- black-and-white timing structures;
- one 5×5 primary alignment reference plus compact 3×3 secondary alignment markers on larger symbols;
- RGB calibration swatches;
- structural black/white references;
- a two-column zig-zag physical data-position path;
- deterministic spectral-spatial interleaving of logical codeword cells;
- four-state masking;
- GF(256) Reed-Solomon ECC with error + erasure decoding;
- per-module RGBW confidence for scanner-assisted erasures;
- CRC-32 integrity verification;
- optional versioned AES-256-GCM Secure Payload envelope.

White is a valid data state.

QuadQR still uses exactly three large finder patterns, just like standard QR. Starting at version 2, alignment markers follow the standard QR version-dependent center schedule. The bottom-right alignment reference remains a full 5×5 marker and is used as the fourth homography reference; additional distributed markers are compact 3×3 black rings with white centers. Version 1 keeps one QuadQR-specific 5×5 bottom-right bootstrap marker because it otherwise would have no fourth projective reference.

The decoder does not treat a white-looking area as automatically empty. It reconstructs the matrix geometry first and then determines whether a sampled position is structural or data.

---

## Color mapping

The current mapping is intentionally simple:

```text
00 → Red
01 → Green
10 → Blue
11 → White
```

Ideal display-space reference colors are conceptually:

```text
Red   → (255,   0,   0)
Green → (  0, 255,   0)
Blue  → (  0,   0, 255)
White → (255, 255, 255)
```

Real camera input is not expected to match those exact values.

QuadQR includes calibration and nearest-color classification so the scanner can work with observed colors after lighting, camera processing, perspective changes, and other image transformations. The clean-frame path stays fast: QuadQR tries the normal detected geometry and observed palette first. Only after that fails does it progressively try stronger recovery, including white balancing, spatial normalization, Auto Tone / Auto Contrast / Auto Color-style enhancement, and bounded sub-module geometry refinement. For live video, QuadQR scans the CSS-visible `object-fit: cover` camera region instead of the hidden full sensor frame, so the code keeps the same apparent size/resolution the user sees in the guide. If finder geometry is already strong but color decoding fails, a QR-only rectified pixel enhancement retry is performed immediately; whole-frame enhancement remains reserved for harder locator failures.

---

## Reed-Solomon error correction

QuadQR uses Reed-Solomon over:

```text
GF(2^8) = GF(256)
```

Primitive polynomial:

```text
x^8 + x^4 + x^3 + x^2 + 1
0x11d
```

One Reed-Solomon symbol is one byte.

Since one byte becomes four QuadQR data cells, ECC symbols stay naturally aligned with the RGBW representation.

### Versions 2 through 40

| Profile | Parity bytes per body block | Correctable byte symbols per block |
|---|---:|---:|
| L | 12 | 6 |
| M | 24 | 12 |
| Q | 36 | 18 |
| H | 48 | 24 |

### Version 1 compact profile

| Profile | Body parity bytes | Correctable body byte symbols |
|---|---:|---:|
| L | 4 | 2 |
| M | 8 | 4 |
| Q | 12 | 6 |
| H | 16 | 8 |

Version 1 also uses a compact 4-byte logical header protected by 4 Reed-Solomon parity bytes, correcting up to 2 damaged header byte symbols.

CRC-32 remains the final integrity check.

---

## Scanner pipeline

The image/camera scanner currently follows this general pipeline:

```text
camera or image RGB frame
  ↓
grayscale structural analysis
  ↓
finder candidate detection
  ↓
version hypothesis
  ↓
primary alignment search
  ↓
homography / perspective correction
  ↓
distributed alignment-grid validation
  ↓
module-grid reconstruction
  ↓
fast observed-RGB decode attempt
  ↓ (only if needed)
white balance + spatial normalization
  ↓ (only if still needed)
Auto Tone / Auto Contrast / Auto Color-style recovery
  ↓ (only if still needed)
sub-module geometry refinement
  ↓
RGB + structural black/white calibration
  ↓
nearest-color classification + confidence scoring
  ↓
four-state unmasking
  ↓
reverse spectral-spatial permutation
  ↓
protected header Reed-Solomon hard decode
  ↓
confidence-guided erasure retry when needed
  ↓
body deinterleaving + error/erasure Reed-Solomon decode
  ↓
CRC-32 verification
  ↓
payload
```

An axis-aligned fallback is also available for clean generated images and simple inputs.

---

## Rendering styles

QuadQR keeps visual styling separate from the wire format. The encoded matrix is unchanged, so applications can choose a renderer without creating a new barcode format.

The current render profiles are:

| Style | Behavior |
|---|---|
| `classic` | Original fully solid square modules. |
| `depth` | Deterministically mixes normal and lightly faded data tiles with subtle edge shading for a layered/3D appearance. |
| `soft` | Uses rounded data tiles for a softer visual treatment. |
| `inset` | Uses narrow recessed edge lighting while preserving the exact encoded center color. |

Finder patterns, timing structures, alignment markers, and calibration cells stay **square and fully solid** in styled output so the visual treatment does not weaken the scanner's geometric/color references.

The `inset` style preserves the exact encoded R/G/B/W color around the center of every data module. Its recessed shading is confined to a narrow outer band, and white data modules remain pure white. This matches the scanner's center-sampling strategy and avoids visual effects bleeding into neighboring cells.

```js
renderToCanvas(code, canvas, {
  imageSize: 720,
  quietZone: 4,
  style: "inset" // classic | depth | soft | inset
});
```

The styling is deterministic. Generating the same matrix with the same style produces the same visual tile treatment rather than changing randomly on every render.

`imageSize` sets the exact square output size in pixels. When neither `imageSize` nor `moduleSize` is supplied, QuadQR renders at **720 × 720 px** by default. `moduleSize` remains available as the lower-level legacy sizing control; when `imageSize` is supplied, the exact image size takes precedence.

### Logo overlays, quiet zones, and SVG export

The renderer can place a centered logo over the symbol. Transparent pixels in the logo stay transparent, so the QuadQR modules remain visible through those areas. Enable `clearBackground` when you want a clean padded white area behind the logo instead.

```js
const logoImage = new Image();
logoImage.src = "/brand-mark.png";
await logoImage.decode();

renderToCanvas(code, canvas, {
  imageSize: 720,
  quietZone: 6,
  style: "classic",
  logo: {
    source: logoImage,
    size: 0.12,
    clearBackground: true,
    padding: 0.65,
    radius: 0.8
  }
});
```

`quietZone` is measured in modules and can be set to `0` or increased for print/camera use. Four modules remains the recommended default.

SVG uses the same matrix, palette, styles, quiet-zone size, and logo geometry:

```js
import { renderToSVG } from "quadqr-js";

const svg = renderToSVG(code, {
  imageSize: 720,
  quietZone: 4,
  logo: {
    source: "data:image/png;base64,...",
    size: 0.12,
    clearBackground: true
  }
});
```

Logo overlays intentionally consume some ECC margin because they cover encoded cells. Keep logos conservative, especially with `L`/`M` ECC. The browser demo verifies the final rendered image before enabling downloads.

---

## Demo

**Live demo:** https://akanshsirohi.github.io/QuadQR/demo/

The browser demo runs directly on GitHub Pages and is split into separate views so the interface does not become overloaded.

### Generator & Image Scanner

Use this tab to:

- enter text/data;
- generate a QuadQR code;
- select ECC;
- control the quiet zone;
- add a centered transparent logo or clear a padded background behind it;
- optionally encrypt using a password or raw 256-bit key;
- inspect version and capacity;
- download PNG or SVG output;
- scan an uploaded image.

### Camera Scanner

The live camera scanner has its own dedicated tab.

This keeps the generator interface lightweight and prevents an always-visible video element from making the main page bulky.

The camera stream automatically stops when you leave the camera tab.

### Benchmark

The benchmark tab provides an easier visual view of:

- capacity by matrix size;
- comparison with standard QR;
- byte gain;
- capacity ratio;
- codec timing.

---

## Getting started

QuadQR can be used as an npm package, directly from a CDN, or from this repository.

### Requirements

- **Node.js 20.19+** for Node.js and CommonJS usage
- npm or another Node package manager for installation
- A modern browser for the demo and documentation site
- HTTPS or localhost for browser camera access

### Install from npm

```bash
npm install quadqr-js
```

Core usage:

```js
import { encodeText, decodeMatrix } from "quadqr-js";

const code = encodeText("Hello from QuadQR", { ecc: "M" });
const result = decodeMatrix(code.matrix);
console.log(result.text);
```

Node PNG/SVG usage:

```js
import { encodeText } from "quadqr-js";
import { savePNG, saveSVG, scanFile } from "quadqr-js/node";

const code = encodeText("Generated on Node.js");
await savePNG(code, "quadqr.png", { imageSize: 720, quietZone: 4 });
await saveSVG(code, "quadqr.svg", { imageSize: 720, quietZone: 4 });

const result = await scanFile("quadqr.png");
console.log(result.text);
```

### CDN / script tag

The `quadqr-js` package can be loaded directly from npm-backed CDNs:

```html
<script src="https://cdn.jsdelivr.net/npm/quadqr-js@1.0.1/dist/quadqr.min.js"></script>
<script>
  const code = QuadQR.encodeText("Hello from a script tag");
</script>
```

The same file is available through unpkg. Pin an exact version in production.

### CLI

Encode and decode directly from the terminal:

```bash
npx quadqr-js encode "Hello QuadQR" -o hello.png
npx quadqr-js decode hello.png
```

Password-protected payloads use the same commands:

```bash
npx quadqr-js encode "Private data" --password "my-password" -o secure.png
npx quadqr-js decode secure.png --password "my-password"
```

See [`docs/CLI.md`](docs/CLI.md) for all CLI options, including raw 256-bit key mode.

### Run from source

```bash
git clone https://github.com/akanshsirohi/QuadQR.git
cd QuadQR
npm install
```

Run the complete test suite:

```bash
npm test
```

Build the distributable browser, Node.js, CDN, and WASM files:

```bash
npm run build
```

Start the interactive demo:

```bash
npm start
```

Start the documentation site:

```bash
npm run docs
```

Run benchmarks:

```bash
npm run benchmark
```

### Optional WASM acceleration

The package ships a prebuilt WASM helper but never requires it.

```js
import { initWasm } from "quadqr-js";

await initWasm();
```

If WASM cannot load, the normal JavaScript codec remains available.

---

## Package entry points

| Import | Purpose |
|---|---|
| `quadqr-js` | Runtime-neutral core, secure payloads, rendering, scanning, optional WASM |
| `quadqr-js/browser` | Browser ESM entry |
| `quadqr-js/node` | Node core plus PNG/file/buffer helpers |
| `quadqr-js/benchmark` | Capacity and codec benchmark helpers |
| `quadqr-js/quadqr.min.js` | Classic browser global/CDN bundle |

The Node PNG path is dependency-free. For JPEG, WebP, or AVIF input, the Node adapter can use `sharp` when the consuming application already has it installed.

---

## Repository layout

```text
library/
  quadqr.js          Core encoder, decoder, renderer, scanner, and public API
  security.js        Secure Payload v1 encryption and key handling
  reed-solomon.js    GF(256) Reed-Solomon implementation
  geometry.js        Version, size, and alignment geometry
  vision.js          Finder detection, perspective correction, and color sampling
  node.js            Node PNG/file/buffer adapters
  wasm.js            Optional prebuilt WASM loader
  benchmark.js       Reusable benchmark utilities

wasm-src/
  quadqr_core.c      Small portable WASM accelerator source

wasm/
  quadqr-core.wasm   Source-tree WASM build output

dist/
  index.js           ESM package entry
  index.cjs          Modern CommonJS wrapper
  browser.js         Browser ESM entry
  node.js            Node entry
  quadqr.js          Classic global browser bundle
  quadqr.min.js      Compact CDN browser bundle
  wasm/              Prebuilt WASM package asset

demo/
  index.html         Interactive generator, image scanner, camera scanner, benchmark
  app.js
  styles.css

docs-site/
  index.html         Standalone documentation website
  app.js
  styles.css

docs/
  README.md          Markdown documentation index
  GETTING_STARTED.md
  API.md
  BROWSER_CDN.md
  NODE.md
  SECURITY.md
  CLI.md
  WASM.md

types/               TypeScript declarations for JavaScript consumers
bin/                 `quadqr` CLI (`npx quadqr-js`)
scripts/             Build, benchmark, and local server scripts
tests/               Codec and package distribution tests
FORMAT.md             Wire-format specification
AGENT.md              Development guidance
README.md             Project overview
```

---

## Main API

### `encodeText(text, options?)`

```js
const code = encodeText("Hello from QuadQR", {
  version: "auto",
  minVersion: 1,
  maxVersion: 40,
  ecc: "M"
});
```

### `encodeBytes(bytes, options?)`

Encodes arbitrary binary data from a `Uint8Array`.

```js
const code = encodeBytes(myBytes, {
  version: "auto",
  ecc: "M"
});
```

### `encodeSecureText(text, options?)`

Secure encoding is asynchronous because it uses Web Crypto.

Password mode:

```js
const code = await encodeSecureText("Private message", {
  ecc: "M",
  security: {
    mode: "password",
    password: "correct horse battery staple"
  }
});
```

Raw 256-bit key mode:

```js
const key = generateRaw256Key();

const code = await encodeSecureText("Device configuration", {
  ecc: "M",
  security: {
    mode: "raw-key",
    key
  }
});
```

Raw keys may be supplied as an exact 32-byte `Uint8Array` or as a 64-character hexadecimal string. By default, raw-key envelopes include a short SHA-256 key fingerprint (`keyIdHex`) that helps an application select the correct secret key without storing the key inside the QuadQR.

### `encodeSecureBytes(bytes, options?)`

Binary equivalent of `encodeSecureText()`.

### `decryptDecoded(result, credentials)`

A secure matrix/image scan first returns encrypted metadata without exposing plaintext:

```js
const locked = decodeMatrix(matrix);

console.log(locked.secure);             // true
console.log(locked.requiresDecryption); // true
console.log(locked.security.mode);       // password | raw-key
```

Then decrypt it:

```js
const result = await decryptDecoded(locked, {
  password: "correct horse battery staple"
});

console.log(result.text);
```

For raw-key mode:

```js
const result = await decryptDecoded(locked, { key });
```

The decrypted result preserves the encrypted envelope as `encryptedPayload` for applications that need both forms.

### `decodeMatrix(matrix, options?)`

Decodes an already reconstructed QuadQR matrix.

```js
const result = decodeMatrix(matrix);
```

When a scanner has per-cell confidence values, they can also be supplied directly:

```js
const result = decodeMatrix(matrix, {
  cellConfidence: confidenceMatrix
});
```

The result reports fields such as `spectralInterleaving`, `confidenceAssisted`, `erasureSymbols`, and `correctedSymbols`. Secure symbols additionally report `secure`, `requiresDecryption`, and parsed `security` metadata while keeping `text` unset until successful decryption.

### `renderToCanvas(codeOrMatrix, canvas, options?)`

Renders a QuadQR symbol into a browser canvas. `imageSize` sets the exact square pixel output and defaults to 720 when neither sizing option is supplied. `moduleSize` remains available for legacy pixels-per-module sizing. `options.style` supports `classic`, `depth`, `soft`, and `inset`. `quietZone` controls the border in modules. `logo` accepts a loaded image/canvas source or `{ source, size, clearBackground, padding, radius, backgroundColor }`.

### `renderToImageData(codeOrMatrix, options?)`

Returns an ImageData-like object and supports the same rendering styles as `renderToCanvas()`:

```js
{
  width,
  height,
  data
}
```

This is also useful for tests and non-DOM workflows.

When a logo is used with `renderToImageData()`, its source must be an ImageData-like `{ width, height, data }` object so the renderer can composite it without DOM APIs.

### `renderToSVG(codeOrMatrix, options?)`

Returns a standalone SVG string using the same exact `imageSize`, render styles, and quiet-zone controls. SVG logo sources can be a URL/data URL string or an object with a `src` string. The SVG remains vector-sharp regardless of how large the preview is displayed.

### `scanImageData(imageData, options?)`

Runs the complete perspective-aware and color-aware image scanner. The scanner first tries the normal detected geometry with the observed RGB palette, preserving the fast path for clean images. Only after that fails does it progressively fall back to per-channel white balancing, spatial black/white normalization, tighter centre sampling, a cheap module-grid Auto Tone / Auto Contrast / Auto Color-style recovery, a rectified QR-region pixel enhancement pass, and finally bounded sub-module geometry micro-refinement. If locator detection itself is weakened by a flat/yellow frame, a full-image enhancement retry is also available. RGBW confidence values are carried into Reed-Solomon so ambiguous cells can be treated as erasures when ordinary hard-decision ECC is insufficient.

### `scanFile(file, options?)`

Scans an uploaded browser image file.

### `scanVideoFrame(video, options?)`

Scans one frame from an HTML video element. By default, if the video is displayed with `object-fit: cover`, QuadQR scans the source crop that is actually visible in the element rather than hidden sensor pixels outside the preview. Set `videoCropMode: "full"` to opt out.

### `startCameraScanner(video, options?)`

Starts a reusable live-camera scanning loop. On supported browsers it requests continuous focus/exposure/white-balance camera modes and scans the CSS-visible preview crop. A normal frame always gets the fast RGB-value finder pass first. If that fails, the **same captured frame** enters a QR-guide recovery path: QuadQR progressively crops away 8%, 16%, and 22% of the surrounding camera frame (then tries the full frame as a final fallback), applies the Photoshop-style Auto Color correction inside that code-centric region, and runs finder detection again. This matters because a live preview can contain dark room pixels, browser chrome, a monitor bezel, or other content that completely changes global Auto Color/Otsu statistics even though a manually cropped screenshot scans instantly. Normal scanning stays unchanged and fast because these recovery crops run only after a miss. Finder-only recovery also tries multiple center-weighted Auto Color histograms before threshold bracketing. `cameraAutoColorEvery` defaults to 1 so the same-frame Auto Color recovery is attempted immediately after each fast miss. Multi-frame voting remains enabled by default with a four-frame history. The optional `onDiagnostic(event)` callback exposes finder candidates, active locator method, crop/geometry/version hypothesis, recovery method, timing, and scan dimensions. `onResult(result, frame)` receives the exact raw decoded camera frame and, when Auto Color was used, the enhanced recovery pixels and their crop rectangle, so UIs can keep the frozen frame and finder overlay aligned.

### `getVersionInfo(version, options?)`

Returns information such as:

- matrix size;
- number of data cells;
- theoretical raw bits;
- usable payload capacity;
- structural metadata.

---

## Tests

Run:

```bash
npm test
```

The current test suite covers areas including:

- RGBW 2-bit mapping;
- binary round trips;
- Unicode text round trips;
- automatic version selection;
- all ECC profiles;
- version 1 compact framing;
- capacity boundaries;
- deliberate Reed-Solomon corruption recovery;
- Reed-Solomon error + erasure recovery;
- zero-overhead spectral-spatial permutation validation;
- confidence-assisted recovery beyond the ordinary hard-error limit;
- rotation handling;
- generated-image scanning;
- perspective distortion;
- color-cast scanning;
- dirty-camera stress scanning with strong yellow cast, haze, blue-channel suppression, and blur;
- low-contrast warm-camera regression where normal scanning fails but progressive Auto Tone / Contrast / Color recovery succeeds;
- multi-frame classification voting;
- benchmark reference data;
- timed codec round trips;
- password-mode secure round trips and wrong-password rejection;
- raw 256-bit key round trips, key fingerprinting, and wrong-key rejection;
- secure rendered-image scan and decryption.

---

## Current limitations

QuadQR is still experimental.

Important areas that need more research and real-device testing include:

- printed codes across different printers and inks;
- paper color and reflectivity;
- display brightness and color profiles;
- screen glare;
- moiré patterns;
- motion blur;
- very small modules;
- extreme camera angles;
- low-light scanning;
- RGBW confusion under difficult illumination;
- damaged or partially hidden symbols;
- standardized recovery percentages;
- equal-reliability comparison with ISO QR Code;
- local/non-projective distortion correction using the distributed alignment grid;
- formal print-quality grading;
- performance across different phones and camera systems;
- memory-hard password KDF option such as Argon2id for environments where a small WASM/runtime dependency is acceptable;
- public/private-key secure payload mode.

The project should currently be treated as a research and experimental implementation rather than a replacement for standardized QR Code in production-critical environments.

---

## Roadmap

- [ ] Equal-reliability benchmark against standard QR
- [ ] Automated camera torture-test suite
- [ ] Blur, JPEG, noise, perspective, and lighting benchmarks
- [ ] Print-and-rescan dataset
- [x] Confidence-based RGBW classification
- [x] Improved adaptive color calibration
- [x] Distributed alignment patterns for large versions
- [ ] Interleaving tuned for localized physical damage
- [ ] Real-device benchmark dataset
- [ ] Formal versioned QuadQR specification
- [ ] Implementations in additional languages
- [ ] Independent decoder implementation

---

## Why keep the square design?

QuadQR intentionally keeps square modules and a square overall matrix.

Square cells:

- tessellate without gaps;
- provide predictable row/column addressing;
- maximize colored area inside each module;
- are easy to sample at their center;
- work naturally with perspective correction;
- keep the geometry relatively simple for camera scanning.

Alternative module shapes may be interesting visually, but the current focus is data density, reliability, and scan robustness.

---

## Is QuadQR a QR Code replacement?

Not currently.

Standard QR Code has enormous advantages:

- decades of deployment;
- international standardization;
- extremely mature decoders;
- broad device support;
- extensive real-world testing;
- proven print reliability.

QuadQR is exploring a different question:

> **What can a QR-inspired matrix code look like if we design its data layer around modern color-capable cameras and displays?**

The goal is experimentation, measurement, and learning.

---

## Contributing

Contributions, experiments, test images, scanner improvements, benchmarking ideas, and independent implementations are welcome.

If you are contributing changes to the wire format, please also update:

```text
FORMAT.md
```

Changes that affect capacity, ECC, scanning behavior, or version selection should include tests where practical.

---

## Security

Decoded payloads are untrusted input.

Do not automatically execute decoded:

- HTML;
- JavaScript;
- shell commands;
- application commands;
- URLs.

Applications using QuadQR should validate and safely handle decoded content just as they would any other external input.

---

## License

AGPL v3.0. See `LICENSE`.

---

## Project status

**Experimental / research project**

QuadQR is actively evolving. Format details may change between versions until the wire format is considered stable.