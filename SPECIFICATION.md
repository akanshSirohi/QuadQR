# QuadQR Technical Specification

## Status

QuadQR is an experimental RGBW matrix symbology. Normal mode uses 4-state RGBW cells, while the optional **High Density Mode** is experimental and uses the 16-state Triangle16 physical layout. It is not ISO/IEC QR Code and is not intended to be decoded by standard QR readers.

The physical matrix format remains **QuadQR Format v5**. Normal application data is always treated simply as UTF-8 text or arbitrary bytes. Compression, signatures, encryption, rendering, and diagnostics are optional features layered around that stable matrix codec.

For exact matrix geometry and Reed-Solomon framing, see [`FORMAT.md`](./FORMAT.md).

## 1. Layer model

```text
Application bytes / UTF-8 text
        │
        ├─ optional compression metadata (internal)
        ├─ optional Ed25519 signature metadata (internal)
        ├─ optional Secure Payload v1 (AES-256-GCM)
        │
        └─ QuadQR Format v5
             ├─ protected header
             ├─ CRC-32
             ├─ GF(256) Reed-Solomon Spectrum ECC
             ├─ spectral-spatial interleaving
             └─ normal RGBW or High Density Triangle16 matrix
```

There is deliberately **no public payload-type registry**. Applications do not select URL, JSON, contact, Wi-Fi, or other semantic types. They encode text or bytes and interpret that data themselves.

## 2. Physical cell alphabet

Data modules use exactly four states:

| State | Bits | Internal value |
|---|---|---:|
| Red | `00` | 0 |
| Green | `01` | 1 |
| Blue | `10` | 2 |
| White | `11` | 3 |

Structural black is separate from the data alphabet. One encoded byte maps to exactly four RGBW data cells.

### High Density Mode

When `highDensity: true` is selected, each payload module has a fixed `/` diagonal and two independently classified RGBW regions. This creates 16 states and 4 raw bits per body cell. The protected header stays solid-color at 2 bits per cell for robust bootstrap recovery, then header flag bit 6 tells the decoder that the ECC/body stream uses Triangle16 packing. Scanner sampling uses three interior anchors per triangle, robust aggregation, and a spatial-instability penalty while excluding the diagonal boundary.

## 3. Matrix sizing

```text
size = 21 + 4 × (version - 1)
version = 1..40
```

Three 7×7 finder patterns are always present. Version 1 has the legacy QuadQR 5×5 bottom-right alignment marker. Versions 2–40 use the distributed alignment schedule defined in `FORMAT.md`.

## 4. Format v5 header flags

The protected Format v5 header uses:

```text
bit 0      UTF-8 text flag
bits 1..2  ECC profile id
bit 3      Secure Payload v1 envelope
bit 4      internal payload-extension metadata present
bit 5      signed-payload hint
bit 6      High Density Mode flag
bit 7      reserved
```

Bit 4 is an implementation/interoperability hint used only when compression or signing requires metadata. It is not a user-selectable payload mode.

## 5. Spectrum ECC

The field remains:

```text
GF(2^8) = GF(256)
primitive polynomial = 0x11d
```

Version 2+ parity profiles:

| Profile | Parity bytes/block | Correctable unknown byte errors/block |
|---|---:|---:|
| L | 12 | 6 |
| M | 24 | 12 |
| Q | 36 | 18 |
| H | 48 | 24 |

The decoder retains per-cell color confidence and one bounded alternate hypothesis from image/camera classification. Low-confidence bytes can first be promoted to known erasures, allowing Reed-Solomon recovery to use the existing parity budget more efficiently. If hard and error/erasure decoding still fail, Spectrum ECC 2.0 may try the alternate state for a bounded set of the least-confident cells. Candidate search is limited to single substitutions and a small pair set by default, and every successful path must still satisfy Reed-Solomon verification and CRC-32.

## 6. Internal payload extension envelope

Compression and signing require a small amount of metadata. QuadQR stores that metadata in an **internal extension envelope** only when needed. Applications should normally use `encodeText()`, `encodeBytes()`, `encodeSignedText()`, or `encodeSignedBytes()` and never construct this envelope themselves.

Current envelope magic:

```text
QPX1
```

Fixed header size: **16 bytes**.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | ASCII magic `QPX1` |
| 4 | 1 | Extension version (`3`; decoder also accepts legacy `1` and `2`) |
| 5 | 1 | Flags |
| 6 | 1 | Compression ID |
| 7 | 1 | Signature algorithm ID |
| 8 | 4 | Original application payload length, big-endian |
| 12 | 1 | Signing key-ID length (v2+); legacy signer-label length in v1 |
| 13 | 1 | Optional embedded public-key length |
| 14 | 1 | Signature length |
| 15 | 1 | Reserved (`0`) |

Variable bytes follow as:

```text
keyId || optionalPublicKey || signature || storedPayload
```

Envelope flags currently use:

```text
bit 0  signed
bit 1  compressed
bit 2  public key embedded
```

The envelope contains no semantic content type. The Format v5 text flag still determines whether the recovered application payload should be decoded as UTF-8 text.

## 7. Compression

Compression IDs:

```text
0 = none
1 = QuadQR portable LZ (legacy)
2 = QuadQR portable raw DEFLATE
3 = bundled Brotli
```

Compression ID `1` is the original LZSS-style stream with groups of up to eight tokens. Each group begins with one flag byte. A flag bit of `0` means a one-byte literal. A flag bit of `1` means a two-byte back-reference:

```text
12-bit offset: 1..4095 bytes
4-bit length: stored value + 3, therefore 3..18 bytes
```

Compression ID `1` keeps the original QuadQR LZSS-style stream. Encoder levels `1..9` control candidate-history depth and bounded lazy-match effort; level 6 preserves the historical 32-candidate search depth. The 4095-byte window, 3..18 byte back-reference format, and decoder remain unchanged, and the level is not serialized.

Compression ID `2` is a raw RFC 1951 DEFLATE stream. QuadQR's portable encoder uses a deterministic fixed-Huffman block, a 32 KiB LZ77 window, distances up to 32768 bytes, and matches up to 258 bytes. Encoder levels `1..9` control candidate-chain depth and lazy-match effort; the level is not serialized and does not change decoder behavior. The QuadQR decoder accepts the stored/fixed block forms emitted by the library.

Compression ID `3` is a standard Brotli stream produced and decoded by QuadQR's bundled synchronous JavaScript codec. It uses no Node `zlib`, browser `CompressionStream`, DOM API, native addon, or network-loaded codec at runtime. Brotli is especially effective for repetitive text and structured payloads, while DEFLATE and legacy LZ remain available for deterministic selection and backward compatibility.

Public compression modes are:

```text
none
auto
smart
brotli
deflate
lz
```

`compression: "auto"` is the fast balanced policy. It evaluates LZ level 6, DEFLATE level 6, and Brotli quality 6 exactly once and chooses the smallest complete stored representation. For unsigned payloads that comparison includes the 16-byte extension-envelope cost, so Auto remains zero-overhead when compression is not useful.

`compression: "smart"` is the opt-in CPU-heavy policy. It begins with the Auto candidates, computes the resulting Format v5 QuadQR version using the selected ECC/profile/version bounds, and only escalates when the next smaller matrix is plausibly reachable. The strong stage tests DEFLATE 8 and Brotli 9. If the symbol remains close to a smaller-version boundary, the maximum stage tests DEFLATE 9 and Brotli 11. With an explicitly requested fixed version, Smart does not chase a smaller matrix, but it may escalate when the balanced result does not fit and stronger compression can plausibly make that requested version fit. Signed and secure pipelines include their fixed envelope overhead when evaluating those version boundaries.

Explicit `compression: "lz"` and `compression: "deflate"` accept `compressionLevel` `1..9` and default to 6. Explicit `compression: "brotli"` accepts `compressionLevel` `0..11` and defaults to 11. Compression levels are encoder-only parameters and are intentionally not stored in the extension envelope because LZ, RFC 1951, and Brotli decoders do not require them. Auto and Smart use LZ level 6; Smart's staged escalation remains focused on DEFLATE/Brotli.

Compression occurs before signing, encryption, and Format v5 ECC.

## 8. Signed QuadQR

Signature algorithm ID `1` is **Ed25519**.

Signed payloads in extension v2/v3 store:

```text
optional compact key ID
64-byte Ed25519 signature
optional 32-byte raw Ed25519 public key only when explicitly requested
```

The normal production profile does **not** embed the public key. The signature covers:

```text
16-byte extension header
|| key ID
|| optional embedded public key
|| stored payload bytes
```

The signature field itself is excluded from the signed message.

The private Ed25519 key is used only by the issuer to create signatures and must never be embedded in a QuadQR. Verification uses a trusted public key supplied externally by the application, server, certificate, or trusted-key registry. The optional key ID is only an identifier that helps the verifier select the correct trusted public key.

For compatibility or self-contained integrity checks, implementations may set `embedPublicKey: true`. A signature verified only against a key embedded in the same QuadQR proves integrity and key possession, but does not establish a trusted signer identity. Such verification should be reported separately from verification against an external trust anchor.

Legacy extension v1 symbols used a signer label and embedded public key. Decoders may continue to read and verify those symbols for backward compatibility.

## 9. Secure + signed composition

When compression, signing, and encryption are combined, QuadQR uses:

```text
application payload
→ optional compression
→ optional Ed25519 signature metadata
→ AES-256-GCM Secure Payload v1
→ Format v5 ECC/matrix
```

After scanning:

```text
Format v5 decode
→ AES-GCM authentication/decryption
→ internal compression/signature metadata processing
→ application payload
→ optional Ed25519 signature verification
```

This keeps signature metadata confidential when encryption is enabled while preserving offline verification after decryption.

## 10. Text and binary APIs

Text and bytes are first-class without semantic payload types:

- `encodeText()` / `decodeMatrix().text` for UTF-8 text;
- `encodeBytes()` for arbitrary bytes;
- `encodeUint8Array()` / `decodeUint8Array()` as explicit byte-oriented convenience APIs.

Compression works on both text and byte payloads through the same `compression` option.

## 11. Rendering profiles

Rendering does not modify the encoded matrix.

### Screen mode

Uses the normal RGBW palette and permits:

```text
classic
soft
depth
inset
```

### Print mode

`mode: "print"` applies conservative defaults:

- minimum quiet zone of 4 modules unless explicitly overridden;
- print-safe darker RGB primaries;
- Classic solid-module rendering by default;
- physical-size guidance through `getPrintGuidance()`.

Recommended general-purpose starting module size is **0.40 mm/module**. Real printer, paper, ink/toner, lamination, lighting, and camera validation remains necessary for production deployments.

## 12. Logo safety

Logos are rendering overlays and never modify Format v5 data structures.

`size: "auto"` estimates a conservative logo ratio from:

- ECC profile;
- encoded utilization;
- version 1 compact-profile penalty;
- clear-background usage;
- screen vs print mode.

`findMaxSafeLogoSize()` can empirically search the largest decodable logo size when an ImageData-like logo is available. Generated symbols should still be verified after final rendering.

## 13. Scanner diagnostics

Successful image scans expose normalized diagnostic fields including:

```text
confidence
geometryConfidence
calibrationConfidence
structureConfidence
eccUtilization
correctedErrors
erasureSymbols
```

With `debug: true`, the scanner can also report stage state, geometry candidates, finder/vision passes, latest sampled matrix, confidence matrix, color-normalization method, and the failed stage when decoding does not complete.

Debug output is diagnostic evidence, not a cryptographic assurance score.

## 14. Scanability score and torture testing

`runImageStressTest()` and `assessScanability()` use deterministic synthetic distortions to estimate robustness against:

- blur;
- low brightness;
- high exposure;
- uneven shadow;
- contrast loss;
- perspective distortion;
- JPEG-like quantization/block artifacts;
- downscaling.

Current rating bands:

```text
90–100  Excellent
75–89   Good
50–74   Risky
0–49    Likely unscannable
```

These scores are regression/testing aids. They do not replace validation with real phone cameras, printers, displays, paper stocks, lighting conditions, and physical damage.

## 15. Capacity planning

Capacity is determined from the actual Format v5 layout, protected header, CRC, and Spectrum ECC plan. Compression can reduce stored payload bytes, while signatures and encryption add metadata bytes before the matrix codec.

The benchmark helper can report:

- minimum QuadQR version;
- encoded bytes;
- remaining capacity;
- utilization;
- approximate same-letter standard QR byte-mode version.

When only a payload byte count is known, `compression: "auto"` cannot predict the gain because compressibility depends on the actual bytes.

Standard QR comparisons use the same **nominal ECC letter only**. QuadQR and ISO QR recovery strengths are not equivalent and should not be presented as such.

## 16. Compatibility principles

Implementations should follow these rules:

1. Keep RGBW mapping exactly `R=00, G=01, B=10, W=11`.
2. Keep GF(256) Spectrum ECC and its errors+erasures behavior.
3. Preserve Format v5 decoding for normal and Secure Payload symbols.
4. Keep application semantics outside the QuadQR codec. Do not require a growing content-type registry.
5. Treat compression/signature metadata as internal transport metadata, not a separate user payload mode.
6. Treat `keyId` only as an identifier. Signer trust comes from an external trusted public-key binding.
7. Keep rendering effects out of structural finder/timing/alignment/calibration modules.
8. Validate public format changes with both matrix and rendered-image scanner tests.

## 17. Reference implementation

The JavaScript implementation in this repository is the current reference implementation. Public entry points are documented under `docs/` and exercised by `tests/self-test.js` and `tests/package-test.js`.
