# AGENT.md

## Goal

## Language

- QuadQR is JavaScript-only. Keep runtime, tests, CLI, demo, documentation, scripts, package entry points, and source declarations in JavaScript unless a different language is explicitly requested.

Develop and experimentally validate the QuadQR custom 2D code.

The current format uses the stable/default RGBW profile plus an experimental High Density Mode. Do not add legacy RGB/ternary compatibility unless explicitly requested.

## Non-negotiable format decisions

- Overall symbol remains square.
- Individual modules remain square.
- The base color alphabet is exactly four states: red, green, blue, white.
- Mapping is red=`00`, green=`01`, blue=`10`, white=`11`.
- Default `rgbw` data cells use one color and store exactly 2 raw bits; one byte maps to four RGBW cells.
- Experimental `triangle16` body cells use one fixed `/` diagonal with two independently colored RGBW regions and therefore 16 states / 4 raw bits; one body byte maps to two Triangle16 cells.
- Triangle16 protected-header cells remain same-color pairs (`R/R`, `G/G`, `B/B`, `W/W`) and retain four cells per header byte so bootstrap recovery stays robust.
- Header flag bit 6 declares Triangle16. Do not repurpose it.
- ECC is GF(256) Reed-Solomon over byte symbols with errors+erasures support.
- New encoding uses zero-overhead spectral-spatial cell interleaving; do not replace it with contiguous placement without explicit compatibility work.
- Image scanning must retain per-cell classification confidence and a bounded second hypothesis. Spectrum ECC 2.0 may use confidence for RS erasures and the second hypothesis for bounded soft-decision retries.
- Structural black remains separate from the four data-state values.
- Structural white and data white may share the same visible/internal value because position determines semantics.
- Secure Payload is optional and must remain layered above the matrix/ECC codec. Never make encryption mandatory for normal QuadQR symbols.
- Secure Payload v1 uses AES-256-GCM. Password mode currently uses PBKDF2-HMAC-SHA-256; raw-key mode requires exactly 32 bytes.
- Header bit 3 marks a secure envelope. Preserve backward decoding for existing unencrypted Format v5 symbols.

## High Density Mode (experimental)

`highDensity: false` is the public library and demo default. `highDensity: true` enables the experimental Triangle16 implementation. Do not make High Density Mode the default unless explicitly requested.

Triangle16 rules:

- fixed `/` diagonal only; do not encode diagonal orientation as another state;
- upper-left region is the high two bits and lower-right region is the low two bits;
- payload/body cell values are packed `0..15` as `(first << 2) | second`;
- structural black stays `-1` and structural modules never use Triangle16 packing;
- protected header uses solid same-color pairs and flag bit 6 identifies the body profile;
- scanner uses multiple protected interior samples per triangle, penalizes unstable/bleeding regions, and retains the most plausible alternate state for Spectrum ECC 2.0;
- image and camera scanning auto-detect both RGBW and Triangle16;
- if normal perspective geometry is insufficient for split cells, keep the bounded precise-alignment recovery path rather than weakening structure checks globally;
- treat real-world reliable bytes at fixed physical size/distance as the important density metric, not raw bits/cell alone.

See `docs/HIGH_DENSITY_MODE.md` for the current physical mapping and reliability notes.

## Geometry

Keep exactly three primary 7×7 black/white finder patterns. Version 1 keeps its legacy 5×5 bottom-right bootstrap alignment marker. Versions 2–40 follow the standard QR alignment-center schedule, omitting the three positions occupied by primary finder corners. The bottom-right primary alignment marker is 5×5; every other distributed alignment marker is a compact 3×3 black ring with a white center.

The camera scanner depends on these structures for finder detection, version estimation, and homography.

## Calibration

Reserved red, green, and blue swatches are sampled from the captured image.

Black and white references come from known structural cells. White is a data state, so changes to white classification must be tested carefully under exposure, glare, and warm/cool lighting.

## ECC

Current field:

```text
GF(2^8) = GF(256)
primitive polynomial = 0x11d
```

ECC profiles:

- L: 12 parity bytes, correct up to 6 byte symbols per block
- M: 24 parity bytes, correct up to 12 byte symbols per block
- Q: 36 parity bytes, correct up to 18 byte symbols per block
- H: 48 parity bytes, correct up to 24 byte symbols per block

Do not replace GF(256) with a ternary field. RGBW keeps direct 2-bit grouping and Triangle16 packs two 2-bit RGBW regions into each 4-bit body cell. Confidence-aware recovery must reuse the existing parity budget rather than silently increasing ECC overhead and reducing capacity.

## Required tests after codec changes

Run:

```bash
npm test
```

Tests should cover:

1. exact RGBW byte-to-four-cell mapping and Triangle16 byte-to-two-body-cell mapping;
2. GF(256) RS syndrome and correction;
3. UTF-8 and binary round trips;
4. all ECC profiles;
5. all four RGBW data states;
6. rotation;
7. capacity boundaries;
8. protected-header correction;
9. body RS correction and failure beyond correction limits;
10. error + erasure RS recovery;
11. spectral-spatial permutation uniqueness;
12. confidence-assisted recovery beyond the hard-decision error limit;
13. clean rendered image scanning for RGBW and Triangle16;
14. perspective distortion plus camera-style color cast, including a dense/high-utilization Triangle16 regression;
15. password-mode secure encode/decode/decrypt;
16. wrong-password authentication failure;
17. raw 256-bit key mode, automatic key ID, and wrong-key failure;
18. secure rendered-image scanning followed by decryption.

Do not accept a codec change that only passes direct matrix decoding but fails rendered image scanning.

## Secure Payload

Keep security framing in `library/security.js`. The RGBW matrix codec should only know that secure body bytes are opaque payload and that header flag bit 3 is set.

Current envelope version: `1`. Current authenticated encryption: `AES-256-GCM`.

Password mode:

```text
password -> PBKDF2-HMAC-SHA-256 -> 256-bit AES key
```

Default PBKDF2 iterations: `600000`. A 16-byte random salt and 12-byte random nonce are required per encryption.

Raw-key mode accepts exactly 32 bytes. The default 8-byte SHA-256 fingerprint is a key selector only. Never put the actual raw key into the symbol.

Any future Argon2id or public-key mode should use a new security/KDF/mode id while retaining the versioned envelope approach. Do not change Spectrum ECC parity solely because a payload is encrypted.

## Demo UX

Keep the live camera scanner separate from the generator view.

Current demo navigation:

- Generator & image scan
- Camera scanner

Do not put the live camera panel back into the main generator grid unless explicitly requested. Stop the camera stream when leaving the camera view.

## Claims

It is valid to state:

```text
RGBW:       4 states  = log2(4)  = 2 raw bits per data cell
Triangle16: 16 states = log2(16) = 4 raw bits per body data cell
```

Triangle16's protected header remains RGBW-equivalent at 2 bits/cell. Do not claim the completed format always stores exactly 2x or 4x the user payload of standard QR at the same physical size. Structural overhead, ECC, headers, calibration, camera pixel coverage, perspective accuracy, and standard QR's specialized encoding modes affect the final comparison.

## Priorities for future work

1. Repeatable benchmark/torture-test framework.
2. Real phone-camera dataset.
3. Print tests under multiple printers/papers.
4. Color-state confusion matrix and confidence-threshold tuning from real captures.
5. Tune affine/local color calibration from real camera and print datasets.
6. Tune Spectrum ECC 2.0 soft-search thresholds and Triangle16 alternate-state ranking from measured confusion data.
7. Spatial damage/interleaving benchmarks and burst-damage comparison against legacy placement.
8. Standard QR comparison at matched physical dimensions and recovery targets.
9. Local/non-projective distortion correction using the distributed alignment grid.


## Version 1 compact small-symbol profile

Version 1 (21×21) intentionally uses different framing from versions 2–40. Do not replace it with the normal 10+8-byte protected header or normal M/Q/H body parity without re-running capacity and camera tests.

- compact logical header: 4 bytes
- compact header RS parity: 4 bytes
- CRC remains CRC-32
- v1 body parity L/M/Q/H: 4/8/12/16 bytes
- current v1-M user capacity: 24 bytes
- normal v2+ framing and ECC remain unchanged

Any change to this profile must keep exact-capacity encode/decode, ECC corruption recovery, image scan, and benchmark tests passing.

## Rendering styles

Rendering styles are presentation-only. Keep wire-format matrix values unchanged. `classic`, `depth`, `soft`, and `inset` are implemented in `library/quadqr.js`. Styled RGBW data cells may vary visually, but finder, timing, alignment, and calibration cells must remain solid and scanner-safe. For `inset`, keep the center sample region at the exact encoded color and never let effects spill into adjacent modules. Triangle16 payload cells intentionally bypass decorative styles and render as exact hard-edged triangles because effects reduce the safe sampling area around the diagonal. Add a scan round-trip test for any new renderer style.

## Library distribution

QuadQR is now distributed as a multi-runtime JavaScript package. Keep one codec implementation and thin runtime adapters.

Public package entry points:

- `quadqr`: core API and optional WASM loader;
- `quadqr/browser`: browser ESM entry;
- `quadqr/node`: Node PNG/file helpers plus core API;
- `quadqr/benchmark`: benchmark helpers;
- `dist/quadqr.min.js`: classic CDN/global build exposing `globalThis.QuadQR`.

Do not fork the codec into separate browser and Node implementations. `scanImageData()` and `renderToImageData()` are the runtime-neutral pixel boundary.

`dist/` is generated by `npm run build`; do not hand-edit files under `dist/`. The checked-in `wasm/quadqr-core.wasm` is the prebuilt fallback used when a maintainer does not have clang installed. Consumers never need clang or a WASM compiler.

Node's dependency-free image path must continue to support PNG generation and PNG scanning. Optional formats may use a host-provided `sharp`, but QuadQR itself should not acquire a mandatory native image dependency without explicit justification.

After package/distribution changes run:

```bash
npm run build
npm test
npm run benchmark
npm run pack:check
```

Package tests must cover ESM, CommonJS, CDN/global loading, WASM initialization, Node PNG generation/scanning, and secure Node image round trips.

## Documentation

Keep both documentation surfaces updated when public APIs change:

- `documentation/`: standalone self-contained static documentation website;
- `docs/`: Markdown documentation for repositories, npm consumers, and offline reading.

The interactive product demo remains under `demo/`; do not merge it into the documentation site. Keep `demo/compute-worker.js` as the background execution boundary for CPU-heavy demo-only work, and keep UI rendering/orchestration in `demo/app.js`.

## Compression 3.0

- Keep payload compression synchronous and runtime-neutral. Core compression code must work in both browsers and server-side Node.js without DOM APIs, `CompressionStream`, or `node:zlib`.
- `compression: "auto"` is the fast path: compare LZ level 6, DEFLATE level 6, and Brotli quality 6 once. `compression: "smart"` is the CPU-heavy version-aware path: only escalate to DEFLATE 8/9 and Brotli 9/11 when a smaller QuadQR version is plausibly reachable. Both must compare complete stored size including applicable envelope overhead. Keep browser demo CPU-heavy work in module Web Workers so synchronous codecs and scanners do not block the UI thread.
- Keep compression ID `1` and the legacy LZ decoder for backward compatibility. Compression ID `2` is portable raw DEFLATE and compression ID `3` is Brotli.
- Brotli must stay synchronous and runtime-neutral in the published core. Do not replace it with `node:zlib`, `CompressionStream`, a DOM-only implementation, or a network-loaded codec. Explicit LZ and DEFLATE support levels 1..9 (default 6); explicit Brotli supports qualities 0..11 (default 11). LZ level 6 must preserve the historical search depth/wire compatibility. Compression levels are encoder-only and must not be added to the wire envelope.
- Do not introduce TypeScript.
